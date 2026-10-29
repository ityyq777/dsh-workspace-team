#!/usr/bin/env node
/**
 * Validate a workspace team config.
 *
 *   node scripts/validate-team.mjs <path/to/team.json> [--workspace <dir>] [--json]
 *
 * Checks:
 *   1. JSON Schema (schema/team.schema.json) with Ajv strict mode.
 *   2. Referenced artifact JSON Schemas compile.
 *   3. Semantic rules that JSON Schema cannot express: references, entry/terminal,
 *      brief channel, same-pipeline channels, SCC boundedness, quorum feasibility,
 *      path safety, agent reuse warnings.
 *
 * Exit code 0 = valid (warnings allowed), 1 = invalid, 2 = usage/setup error.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "..");
const TEAM_SCHEMA = path.join(REPO_ROOT, "schema", "team.schema.json");

function usage(message) {
  if (message) console.error("error: " + message);
  console.error("usage: node scripts/validate-team.mjs <team.json> [--workspace <dir>] [--json]");
  process.exit(2);
}

function parseArgs(argv) {
  let file = null;
  let workspace = null;
  let json = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--json") json = true;
    else if (arg === "--workspace") {
      workspace = argv[++i];
      if (!workspace) usage("--workspace needs a directory");
    } else if (arg === "-h" || arg === "--help") usage();
    else if (arg.startsWith("--")) usage("unknown option " + arg);
    else if (!file) file = arg;
    else usage("unexpected argument " + arg);
  }
  if (!file) usage("missing team.json");
  return { file: path.resolve(file), workspace: workspace ? path.resolve(workspace) : null, json };
}

async function loadAjv() {
  const candidates = ["ajv/dist/2020.js", "ajv"];
  const nodePrefix = path.resolve(path.dirname(process.execPath), "..");
  const dsh = path.join(nodePrefix, "lib", "node_modules", "@deepseek-ai", "dsh", "node_modules", "ajv");
  candidates.push(pathToFileURL(path.join(dsh, "dist", "2020.js")).href);
  candidates.push(pathToFileURL(dsh).href);
  for (const candidate of candidates) {
    try {
      const mod = await import(candidate);
      const Ajv = mod.default ?? mod.Ajv ?? mod;
      if (typeof Ajv === "function") return Ajv;
    } catch {
      // try next
    }
  }
  console.error("error: cannot find ajv. Install it with: npm i -D ajv");
  process.exit(2);
}

const Ajv2020 = await loadAjv();
const AjvDraft7mod = await import("ajv").catch(() => import(pathToFileURL(
  path.join(path.resolve(path.dirname(process.execPath), ".."), "lib", "node_modules", "@deepseek-ai", "dsh", "node_modules", "ajv", "dist", "ajv.js")
).href));
const AjvDraft7 = AjvDraft7mod.default ?? AjvDraft7mod;

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function safeRelative(value, baseDir, label, errors, { mustExist = false } = {}) {
  if (typeof value !== "string" || !value) {
    errors.push(label + ": must be a non-empty string");
    return null;
  }
  if (path.isAbsolute(value)) {
    errors.push(label + ": must be relative, got absolute path " + value);
    return null;
  }
  if (value.includes("\\")) {
    errors.push(label + ": must use forward slashes, got " + value);
    return null;
  }
  const segments = value.split("/");
  if (segments.some((s) => s === ".." || s === "." || s === "")) {
    errors.push(label + ": must not contain empty, '.' or '..' segments: " + value);
    return null;
  }
  const resolved = path.resolve(baseDir, value);
  const prefix = path.resolve(baseDir) + path.sep;
  if (!resolved.startsWith(prefix)) {
    errors.push(label + ": escapes " + baseDir + ": " + value);
    return null;
  }
  if (mustExist) {
    let stat = null;
    try { stat = fs.statSync(resolved); } catch { /* missing */ }
    if (!stat || !stat.isFile()) {
      errors.push(label + ": file not found: " + resolved);
      return null;
    }
    try {
      const real = fs.realpathSync(resolved);
      const realBase = fs.realpathSync(baseDir);
      if (real !== realBase && !real.startsWith(realBase + path.sep)) {
        errors.push(label + ": resolves outside " + baseDir + " via symlink: " + value);
        return null;
      }
    } catch {
      // stat succeeded; realpath failure is unusual, leave the stat check to report it
    }
  }
  return resolved;
}

function uniqueById(items, label, errors) {
  const seen = new Set();
  for (const item of items) {
    if (!isObject(item) || typeof item.id !== "string") continue;
    if (seen.has(item.id)) errors.push(label + ": duplicate id '" + item.id + "'");
    seen.add(item.id);
  }
  return seen;
}

function checkSchemaRefs(schema, schemaFile, configDir, label, errors, seen = new Set()) {
  if (!isObject(schema) && !Array.isArray(schema)) return;
  if (seen.has(schemaFile)) return;
  seen.add(schemaFile);

  function walk(value, pointer) {
    if (Array.isArray(value)) {
      value.forEach((item, i) => walk(item, pointer + "/" + i));
      return;
    }
    if (!isObject(value)) return;
    for (const [key, child] of Object.entries(value)) {
      if (key === "$ref" && typeof child === "string") {
        const ref = child;
        if (ref.startsWith("#")) continue;
        if (/^[a-z][a-z0-9+.-]*:/i.test(ref) || ref.startsWith("//")) {
          errors.push(label + ": remote $ref is not allowed: " + ref + " (at " + (pointer || "/") + ")");
          continue;
        }
        if (path.isAbsolute(ref)) {
          errors.push(label + ": absolute $ref is not allowed: " + ref);
          continue;
        }
        const filePart = ref.split("#")[0];
        if (!filePart) continue;
        const resolved = safeRelative(filePart, configDir, label + " $ref", errors, { mustExist: true });
        if (resolved) {
          const sub = readJson(resolved, errors);
          if (sub) checkSchemaRefs(sub, resolved, configDir, label + " → " + filePart, errors, seen);
        }
        continue;
      }
      walk(child, pointer + "/" + key);
    }
  }

  walk(schema, "");
}

function readJson(file, errors) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (err) {
    errors.push("cannot read/parse " + file + ": " + err.message);
    return null;
  }
}

function tarjan(nodes, edges) {
  let index = 0;
  const stack = [];
  const onStack = new Set();
  const indices = new Map();
  const low = new Map();
  const sccs = [];

  function strongConnect(v) {
    indices.set(v, index);
    low.set(v, index);
    index++;
    stack.push(v);
    onStack.add(v);
    for (const w of edges.get(v) ?? []) {
      if (!indices.has(w)) {
        strongConnect(w);
        low.set(v, Math.min(low.get(v), low.get(w)));
      } else if (onStack.has(w)) {
        low.set(v, Math.min(low.get(v), indices.get(w)));
      }
    }
    if (low.get(v) === indices.get(v)) {
      const scc = [];
      let w;
      do {
        w = stack.pop();
        onStack.delete(w);
        scc.push(w);
      } while (w !== v);
      sccs.push(scc);
    }
  }

  for (const node of nodes) {
    if (!indices.has(node)) strongConnect(node);
  }
  return sccs;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const errors = [];
  const warnings = [];
  const configDir = path.dirname(args.file);
  const workspaceRoot = args.workspace
    ? args.workspace
    : configDir.endsWith(path.join(".dsh", ".dsh-workspace-team"))
      ? path.resolve(configDir, "..", "..")
      : process.cwd();

  const team = readJson(args.file, errors);
  if (!team) return finish(args, errors, warnings, null);

  // 1. JSON Schema
  const schema = readJson(TEAM_SCHEMA, errors);
  if (!schema) return finish(args, errors, warnings, team);

  let validateTeam;
  try {
    const ajv = new Ajv2020({ strict: true, allErrors: true, allowUnionTypes: false });
    validateTeam = ajv.compile(schema);
  } catch (err) {
    errors.push("schema/team.schema.json does not compile: " + err.message);
    return finish(args, errors, warnings, team);
  }

  if (!validateTeam(team)) {
    for (const e of validateTeam.errors ?? []) {
      errors.push("schema" + (e.instancePath || "/") + ": " + e.message + (e.params ? " " + JSON.stringify(e.params) : ""));
    }
    // Still run semantic checks below; they may add useful messages.
  }

  const agents = Array.isArray(team.agents) ? team.agents : [];
  const channels = Array.isArray(team.channels) ? team.channels : [];
  const pipelines = Array.isArray(team.pipelines) ? team.pipelines : [];

  uniqueById(agents, "agents", errors);
  uniqueById(channels, "channels", errors);
  uniqueById(pipelines, "pipelines", errors);

  const agentById = new Map(agents.filter(isObject).map((a) => [a.id, a]));
  const channelById = new Map(channels.filter(isObject).map((c) => [c.id, c]));
  const pipelineById = new Map(pipelines.filter(isObject).map((p) => [p.id, p]));

  const agentUsage = new Map();
  const nodeKey = (pipelineId, nodeId) => pipelineId + "/" + nodeId;
  const pipelineNodes = new Map();
  const pipelineNodeById = new Map();

  for (const pipeline of pipelines) {
    if (!isObject(pipeline) || typeof pipeline.id !== "string") continue;
    const nodes = Array.isArray(pipeline.nodes) ? pipeline.nodes : [];
    pipelineNodes.set(pipeline.id, nodes);
    const map = new Map();
    uniqueById(nodes, "pipeline " + pipeline.id + " nodes", errors);
    for (const node of nodes) {
      if (!isObject(node) || typeof node.id !== "string") continue;
      map.set(node.id, node);
      if (typeof node.agentId === "string") {
        if (!agentById.has(node.agentId)) {
          errors.push("pipeline " + pipeline.id + " node " + node.id + ": unknown agentId '" + node.agentId + "'");
        } else {
          const key = node.agentId;
          if (!agentUsage.has(key)) agentUsage.set(key, []);
          agentUsage.get(key).push(pipeline.id + "/" + node.id);
        }
      }
      if (node.instructions && node.instructions.file) {
        safeRelative(node.instructions.file, configDir, "pipeline " + pipeline.id + " node " + node.id + " instructions.file", errors, { mustExist: true });
      }
      if (node.activation && node.activation.retry && node.activation.onFailure !== "retry") {
        warnings.push("pipeline " + pipeline.id + " node " + node.id + ": retry is configured but onFailure is not 'retry' (retry config will be ignored)");
      }
    }
    pipelineNodeById.set(pipeline.id, map);
  }

  for (const agent of agents) {
    if (!isObject(agent) || typeof agent.id !== "string") continue;
    if (agent.systemPrompt && agent.systemPrompt.file) {
      safeRelative(agent.systemPrompt.file, configDir, "agent " + agent.id + " systemPrompt.file", errors, { mustExist: true });
    }
    const usage = agentUsage.get(agent.id) ?? [];
    if (usage.length === 0) warnings.push("agent " + agent.id + ": not referenced by any node");
    if (usage.length > 1) warnings.push("agent " + agent.id + ": referenced by " + usage.length + " nodes (" + usage.join(", ") + "); activations are serialized per agent");
  }

  // 2. Channels + referenced artifact schemas + file sinks
  const compiledSchemas = new Map();
  for (const channel of channels) {
    if (!isObject(channel) || typeof channel.id !== "string") continue;
    const label = "channel " + channel.id;
    if (!isObject(channel.from) || !isObject(channel.to)) continue;

    const fromNode = channel.from.kind === "node";
    const toNode = channel.to.kind === "node";

    if (fromNode) {
      if (!pipelineById.has(channel.from.pipelineId)) errors.push(label + ": unknown from.pipelineId '" + channel.from.pipelineId + "'");
      const pnodes = pipelineNodeById.get(channel.from.pipelineId);
      if (pnodes && !pnodes.has(channel.from.nodeId)) errors.push(label + ": unknown from.nodeId '" + channel.from.nodeId + "'");
    }
    if (toNode) {
      if (!pipelineById.has(channel.to.pipelineId)) errors.push(label + ": unknown to.pipelineId '" + channel.to.pipelineId + "'");
      const pnodes = pipelineNodeById.get(channel.to.pipelineId);
      if (pnodes && !pnodes.has(channel.to.nodeId)) errors.push(label + ": unknown to.nodeId '" + channel.to.nodeId + "'");
    }

    if (fromNode && toNode && channel.from.pipelineId !== channel.to.pipelineId) {
      errors.push(label + ": node→node channel crosses pipelines (" + channel.from.pipelineId + " → " + channel.to.pipelineId + "); v1 only allows channels inside one pipeline");
    }
    if (channel.from.kind === "external" && channel.to.kind === "external") {
      errors.push(label + ": external → external is not allowed");
    }
    if (channel.from.kind === "external" && channel.to.kind === "external" && channel.to.sink === "file") {
      errors.push(label + ": external user → external file is not allowed");
    }
    if (channel.from.kind === "external" && channel.required !== false) {
      warnings.push(label + ": producer is external; channel.required has no effect");
    }

    if (isObject(channel.artifact)) {
      const art = channel.artifact;
      if (art.minBytes !== undefined && art.maxBytes !== undefined && art.minBytes > art.maxBytes) {
        errors.push(label + ": artifact.minBytes " + art.minBytes + " > maxBytes " + art.maxBytes);
      }
      if (art.kind === "json") {
        const resolved = safeRelative(art.schema, configDir, label + " artifact.schema", errors, { mustExist: true });
        if (resolved) {
          const key = art.schemaDialect === "draft-07" ? "draft-07:" + resolved : "2020-12:" + resolved;
          if (!compiledSchemas.has(key)) {
            const artifactSchema = readJson(resolved, errors);
            if (artifactSchema) {
              checkSchemaRefs(artifactSchema, resolved, configDir, label + " artifact schema " + art.schema, errors);
              try {
                const ajv = art.schemaDialect === "draft-07"
                  ? new AjvDraft7({ strict: false, allErrors: true, validateFormats: false })
                  : new Ajv2020({ strict: false, allErrors: true, validateFormats: false });
                compiledSchemas.set(key, ajv.compile(artifactSchema));
              } catch (err) {
                errors.push(label + ": artifact schema " + art.schema + " does not compile: " + err.message);
              }
            }
          }
        }
      } else if (art.kind === "text" && art.schema !== undefined) {
        errors.push(label + ": text artifact must not declare schema");
      }
      if (channel.to.kind === "external" && channel.to.sink === "file" && art.kind !== "text") {
        errors.push(label + ": file sink only supports text artifacts in v1 (got " + art.kind + ")");
      }
    }

    if (channel.to.kind === "external" && channel.to.sink === "file") {
      const resolved = safeRelative(channel.to.path, workspaceRoot, label + " to.path", errors);
      if (resolved) {
        const configAbs = path.resolve(configDir);
        if (resolved === configAbs || resolved.startsWith(configAbs + path.sep)) {
          errors.push(label + ": file sink must not write inside the team config directory");
        }
      }
    }
  }

  // 3. Pipeline structure
  for (const pipeline of pipelines) {
    if (!isObject(pipeline) || typeof pipeline.id !== "string") continue;
    const nodes = pipelineNodes.get(pipeline.id) ?? [];
    const nodeMap = pipelineNodeById.get(pipeline.id) ?? new Map();
    const nodeIds = new Set(nodes.filter(isObject).map((n) => n.id));

    const inbound = new Map();
    const outbound = new Map();
    for (const node of nodeIds) { inbound.set(node, []); outbound.set(node, []); }
    for (const channel of channels) {
      if (!isObject(channel) || !isObject(channel.from) || !isObject(channel.to)) continue;
      if (channel.from.kind === "node" && channel.from.pipelineId === pipeline.id && nodeIds.has(channel.from.nodeId)) {
        outbound.get(channel.from.nodeId).push(channel);
      }
      if (channel.to.kind === "node" && channel.to.pipelineId === pipeline.id && nodeIds.has(channel.to.nodeId)) {
        inbound.get(channel.to.nodeId).push(channel);
      }
    }

    const start = isObject(pipeline.start) ? pipeline.start : {};
    const entryNodes = Array.isArray(start.entryNodes) && start.entryNodes.length > 0
      ? start.entryNodes
      : [...nodeIds].filter((id) => inbound.get(id).length === 0);
    if (entryNodes.length === 0) errors.push("pipeline " + pipeline.id + ": no entry nodes (no start.entryNodes and every node has an inbound channel)");
    for (const entry of entryNodes) {
      if (!nodeIds.has(entry)) errors.push("pipeline " + pipeline.id + ": start.entryNodes references unknown node '" + entry + "'");
      else if (inbound.get(entry).some((c) => c.from.kind === "node")) warnings.push("pipeline " + pipeline.id + " entry node " + entry + ": has inbound node channels; it can be re-entered, make sure a cycle bound exists");
    }

    const completion = isObject(pipeline.completion) ? pipeline.completion : {};
    const terminalNodes = Array.isArray(completion.terminalNodes) && completion.terminalNodes.length > 0
      ? completion.terminalNodes
      : [...nodeIds].filter((id) => outbound.get(id).length === 0);
    if (terminalNodes.length === 0) errors.push("pipeline " + pipeline.id + ": no terminal nodes (no completion.terminalNodes and every node has an outbound channel)");
    for (const terminal of terminalNodes) {
      if (!nodeIds.has(terminal)) errors.push("pipeline " + pipeline.id + ": completion.terminalNodes references unknown node '" + terminal + "'");
    }
    if (completion.mode === "all-terminal" && terminalNodes.length > 1) {
      // no-op; documented, but worth surfacing
    }

    if (start.briefChannel) {
      const brief = channelById.get(start.briefChannel);
      if (!brief) errors.push("pipeline " + pipeline.id + ": start.briefChannel references unknown channel '" + start.briefChannel + "'");
      else {
        if (brief.from.kind !== "external") errors.push("pipeline " + pipeline.id + ": start.briefChannel '" + start.briefChannel + "' must have from.kind=external");
        if (brief.to.kind !== "node" || brief.to.pipelineId !== pipeline.id) {
          errors.push("pipeline " + pipeline.id + ": start.briefChannel '" + start.briefChannel + "' must target a node in this pipeline");
        } else if (!entryNodes.includes(brief.to.nodeId)) {
          errors.push("pipeline " + pipeline.id + ": brief channel targets '" + brief.to.nodeId + "', which is not an entry node");
        }
      }
    } else if (start.mode === "auto") {
      warnings.push("pipeline " + pipeline.id + ": start.mode=auto without start.briefChannel; entry agents receive no user brief");
    }

    // quorum feasibility
    for (const node of nodes) {
      if (!isObject(node) || typeof node.id !== "string") continue;
      const requiredInbound = inbound.get(node.id).filter((c) => c.delivery?.required !== false).length;
      const inputs = isObject(node.inputs) ? node.inputs : {};
      if (inputs.mode === "quorum") {
        if (requiredInbound === 0) errors.push("pipeline " + pipeline.id + " node " + node.id + ": quorum with no required inbound channels can never activate");
        else if (inputs.quorum > requiredInbound) errors.push("pipeline " + pipeline.id + " node " + node.id + ": quorum " + inputs.quorum + " > required inbound channels " + requiredInbound);
      }
      if (inbound.get(node.id).length === 0 && !entryNodes.includes(node.id)) {
        warnings.push("pipeline " + pipeline.id + " node " + node.id + ": no inbound channels and not an entry node; unreachable");
      }
      for (const channel of inbound.get(node.id)) {
        if (channel.delivery?.timing === "immediate" && inputs.mode === "all") {
          warnings.push("pipeline " + pipeline.id + " node " + node.id + ": immediate delivery on channel " + channel.id + " with inputs.mode=all can bypass join semantics");
        }
      }
      const maxInline = node.inputs?.maxInlineBytes;
      if (maxInline !== undefined && team.settings?.storage?.maxInlineBytes !== undefined && maxInline > team.settings.storage.maxInlineBytes) {
        warnings.push("pipeline " + pipeline.id + " node " + node.id + ": maxInlineBytes exceeds settings.storage.maxInlineBytes");
      }
    }

    // budget sanity
    if (isObject(pipeline.budget)) {
      if (pipeline.budget.maxNodeRuns !== undefined && pipeline.budget.maxNodeRuns < nodeIds.size) {
        warnings.push("pipeline " + pipeline.id + ": budget.maxNodeRuns " + pipeline.budget.maxNodeRuns + " < node count " + nodeIds.size + "; a straight-line run may exhaust the budget");
      }
      if (pipeline.budget.maxArtifacts !== undefined && pipeline.budget.maxArtifacts < nodeIds.size) {
        warnings.push("pipeline " + pipeline.id + ": budget.maxArtifacts " + pipeline.budget.maxArtifacts + " < node count " + nodeIds.size + "; a straight-line run may exhaust the budget");
      }
    }

    // reachability
    const edges = new Map();
    for (const node of nodeIds) edges.set(node, []);
    for (const node of nodeIds) {
      for (const channel of outbound.get(node)) {
        if (channel.to.kind === "node" && channel.to.pipelineId === pipeline.id) edges.get(node).push(channel.to.nodeId);
      }
    }
    const reachable = new Set();
    const stack = entryNodes.filter((id) => nodeIds.has(id));
    while (stack.length > 0) {
      const v = stack.pop();
      if (reachable.has(v)) continue;
      reachable.add(v);
      for (const w of edges.get(v) ?? []) stack.push(w);
    }
    for (const node of nodeIds) {
      if (!reachable.has(node)) errors.push("pipeline " + pipeline.id + " node " + node + ": not reachable from any entry node");
    }
    for (const terminal of terminalNodes) {
      if (nodeIds.has(terminal) && !reachable.has(terminal)) errors.push("pipeline " + pipeline.id + " terminal " + terminal + ": not reachable from any entry node");
    }

    // SCC boundedness
    const sccs = tarjan([...nodeIds], edges);
    for (const scc of sccs) {
      const isCycle = scc.length > 1 || (edges.get(scc[0]) ?? []).includes(scc[0]);
      if (!isCycle) continue;
      const nodeBound = scc.some((id) => {
        const n = nodeMap.get(id);
        return isObject(n) && isObject(n.activation) && Number.isFinite(n.activation.maxActivations);
      });
      const runBound = isObject(pipeline.budget)
        && (Number.isFinite(pipeline.budget.maxNodeRuns) || Number.isFinite(pipeline.budget.maxWallClockMs));
      if (!nodeBound && !runBound) {
        errors.push("pipeline " + pipeline.id + ": cycle [" + scc.join(", ") + "] has no finite bound; set activation.maxActivations on a node in the cycle or pipeline.budget.maxNodeRuns/maxWallClockMs");
      }
    }

    // duplicate channel pair warning
    const pairs = new Map();
    for (const channel of channels) {
      if (!isObject(channel) || !isObject(channel.from) || !isObject(channel.to)) continue;
      if (channel.from.kind !== "node" || channel.from.pipelineId !== pipeline.id) continue;
      if (channel.to.kind !== "node" || channel.to.pipelineId !== pipeline.id) continue;
      const key = channel.from.nodeId + "→" + channel.to.nodeId;
      if (pairs.has(key)) warnings.push("pipeline " + pipeline.id + ": multiple channels between " + key + " (" + pairs.get(key) + ", " + channel.id + "); make sure the consumer can distinguish them");
      else pairs.set(key, channel.id);
    }
  }

  // storage/channel maxBytes consistency
  if (team.settings?.storage?.maxArtifactBytes !== undefined) {
    for (const channel of channels) {
      if (isObject(channel?.artifact) && channel.artifact.maxBytes !== undefined && channel.artifact.maxBytes > team.settings.storage.maxArtifactBytes) {
        errors.push("channel " + channel.id + ": artifact.maxBytes " + channel.artifact.maxBytes + " > settings.storage.maxArtifactBytes " + team.settings.storage.maxArtifactBytes);
      }
    }
  }

  return finish(args, errors, warnings, team);
}

function finish(args, errors, warnings, team) {
  if (args.json) {
    console.log(JSON.stringify({
      file: args.file,
      valid: errors.length === 0,
      errors,
      warnings,
      summary: team && isObject(team) ? {
        id: team.id,
        name: team.name,
        agents: Array.isArray(team.agents) ? team.agents.length : 0,
        channels: Array.isArray(team.channels) ? team.channels.length : 0,
        pipelines: Array.isArray(team.pipelines) ? team.pipelines.length : 0,
      } : null,
    }, null, 2));
  } else {
    if (team && isObject(team)) {
      console.log("team: " + team.id + " (" + team.name + ")");
      console.log("agents: " + (team.agents?.length ?? 0) + ", channels: " + (team.channels?.length ?? 0) + ", pipelines: " + (team.pipelines?.length ?? 0));
    }
    for (const error of errors) console.error("error: " + error);
    for (const warning of warnings) console.error("warn:  " + warning);
    if (errors.length === 0) console.log("valid" + (warnings.length ? " (" + warnings.length + " warning(s))" : ""));
    else console.error("invalid (" + errors.length + " error(s), " + warnings.length + " warning(s))");
  }
  process.exit(errors.length === 0 ? 0 : 1);
}

main();