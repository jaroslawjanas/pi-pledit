import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

type Mode = "default" | "plan" | "acceptEdits";

const MODE_CYCLE: Mode[] = ["default", "acceptEdits", "plan"];

const DEFAULT_SHORTCUT = "f6";

interface PleditConfig {
  shortcut?: string;
  readonlyBash?: string[];
  safeBash?: string[];
  unsafePatterns?: string[];
}

const DEFAULT_READONLY_BASH = [
  "ls ", "find ", "grep ", "rg ", "cat ", "head ", "tail ", "echo ", "pwd ", "which ", "wc ",
  "git status", "git diff", "git log", "git branch", "git stash list", "git show",
];

const DEFAULT_SAFE_BASH = [
  "mkdir ", "touch ", "mv ", "cp ", "rm ", "rmdir ", "sed ",
  "git status", "git diff", "git log", "git branch", "git stash list",
  "npm test", "npm run ", "yarn ", "pnpm ",
];

const DEFAULT_UNSAFE_PATTERNS = [
  "rm -rf", "sudo", "chmod 777", "docker system prune",
];

function getAgentDir(): string {
  const home = os.homedir();
  return path.join(home, ".pi", "agent");
}

function readJson<T>(filePath: string): T | undefined {
  try {
    const raw = fs.readFileSync(filePath, "utf-8");
    return JSON.parse(raw) as T;
  } catch {
    return undefined;
  }
}

function writeJson(filePath: string, data: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2) + "\n", "utf-8");
}

function resolveConfig(cwd: string): Required<PleditConfig> {
  // Defaults
  const config: Required<PleditConfig> = {
    shortcut: DEFAULT_SHORTCUT,
    readonlyBash: DEFAULT_READONLY_BASH,
    safeBash: DEFAULT_SAFE_BASH,
    unsafePatterns: DEFAULT_UNSAFE_PATTERNS,
  };

  // 1. Project config (overrides any provided keys entirely)
  const projectConfigPath = path.join(cwd, ".pi", "pledit.json");
  const projectConfig = readJson<PleditConfig>(projectConfigPath);
  if (projectConfig) {
    if (projectConfig.shortcut) config.shortcut = projectConfig.shortcut;
    if (projectConfig.readonlyBash) config.readonlyBash = projectConfig.readonlyBash;
    if (projectConfig.safeBash) config.safeBash = projectConfig.safeBash;
    if (projectConfig.unsafePatterns) config.unsafePatterns = projectConfig.unsafePatterns;
  }

  // 2. Global config (overrides project for any provided keys)
  const globalConfigPath = path.join(getAgentDir(), "pledit.json");
  const globalConfig = readJson<PleditConfig>(globalConfigPath);
  if (globalConfig) {
    if (globalConfig.shortcut) config.shortcut = globalConfig.shortcut;
    if (globalConfig.readonlyBash) config.readonlyBash = globalConfig.readonlyBash;
    if (globalConfig.safeBash) config.safeBash = globalConfig.safeBash;
    if (globalConfig.unsafePatterns) config.unsafePatterns = globalConfig.unsafePatterns;
  }

  return config;
}

function stripBashWrappers(command: string): string {
  let trimmed = command.trim();
  let changed = true;
  while (changed) {
    changed = false;
    for (const wrapper of ["timeout ", "nice ", "nohup "]) {
      if (trimmed.startsWith(wrapper)) {
        trimmed = trimmed.slice(wrapper.length).trimStart();
        changed = true;
      }
    }
    const envMatch = trimmed.match(/^[A-Za-z_][A-Za-z0-9_]*=\S+\s+/);
    if (envMatch) {
      trimmed = trimmed.slice(envMatch[0].length);
      changed = true;
    }
  }
  return trimmed;
}

function isUnsafe(command: string, patterns: string[]): boolean {
  const trimmed = stripBashWrappers(command);
  return patterns.some((p) => trimmed.includes(p));
}

function isReadonlyBash(command: string, config: Required<PleditConfig>): boolean {
  if (isUnsafe(command, config.unsafePatterns)) return false;
  const trimmed = stripBashWrappers(command);
  return config.readonlyBash.some((p) => trimmed.startsWith(p));
}

function isSafeBash(command: string, config: Required<PleditConfig>): boolean {
  if (isUnsafe(command, config.unsafePatterns)) return false;
  const trimmed = stripBashWrappers(command);
  return config.safeBash.some((p) => trimmed.startsWith(p));
}

function getSavedMode(ctx: ExtensionContext): Mode {
  const entries = ctx.sessionManager.getEntries();
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i];
    if (e.type === "custom" && e.customType === "pledit-mode") {
      const data = e.data as { mode?: Mode } | undefined;
      if (data?.mode && MODE_CYCLE.includes(data.mode)) {
        return data.mode;
      }
    }
  }
  return "default";
}

function persistMode(pi: ExtensionAPI, mode: Mode) {
  pi.appendEntry("pledit-mode", { mode, timestamp: Date.now() });
}

function isPlanFilePath(filePath: string, cwd: string): boolean {
  const resolved = path.resolve(cwd, filePath);
  const plansDir = path.resolve(cwd, ".pi", "plans");
  const rel = path.relative(plansDir, resolved);
  return !rel.startsWith("..") && !path.isAbsolute(rel) && resolved.endsWith(".md");
}

function generatePlanFilename(): string {
  const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  return `plan-${ts}.md`;
}

function buildPlanFile(content: string, meta: Record<string, unknown>): string {
  const frontmatter = Object.entries(meta)
    .map(([k, v]) => `${k}: ${JSON.stringify(v)}`)
    .join("\n");

  return `---\n${frontmatter}\n---\n\n# Plan\n\n${content.trim()}\n`;
}

function statusLabel(mode: Mode): string {
  // No indicator shown in default mode
  if (mode === "plan") return "∥∥ plan mode";
  if (mode === "acceptEdits") return "⏵⏵ accept edits";
  return "";
}

function notifyLabel(mode: Mode): string {
  if (mode === "plan") return "Plan mode — read only";
  if (mode === "acceptEdits") return "Yolo mode — edits auto-approved";
  return "Default mode — prompts before changes";
}

export default function (pi: ExtensionAPI) {
  let currentMode: Mode = "default";
  let touchedPlanFiles: string[] = [];
  const config = resolveConfig(process.cwd());

  pi.registerShortcut(config.shortcut, {
    description: "Cycle permission modes",
    handler: async (shortcutCtx) => {
      const next = MODE_CYCLE[(MODE_CYCLE.indexOf(currentMode) + 1) % MODE_CYCLE.length];
      currentMode = next;
      persistMode(pi, next);
      if (shortcutCtx.hasUI) {
        shortcutCtx.ui.setStatus("pledit", statusLabel(currentMode));
        shortcutCtx.ui.notify(notifyLabel(currentMode), "info");
      }
    },
  });

  pi.on("session_start", async (_event, ctx) => {
    currentMode = getSavedMode(ctx);
    if (ctx.hasUI) {
      ctx.ui.setStatus("pledit", statusLabel(currentMode));
    }
  });

  // ── System prompt injection ────────────────────────────────

  pi.on("before_agent_start", async (event, _ctx) => {
    touchedPlanFiles = [];

    if (currentMode === "plan") {
      const injection =
        `\n\n[PLAN MODE ACTIVE] You are in PLAN MODE. bash is restricted to read-only commands.` +
        `\n- Read files, search the codebase, and analyze thoroughly.` +
        `\n- You may use write and edit ONLY for .pi/plans/*.md files to draft or refine your plan.` +
        `\n- Then produce a structured implementation plan as your final response.` +
        `\n- Include: Summary, Files to Modify, Files to Create, Implementation Steps, Risks, Testing Strategy.` +
        `\n- Do NOT use write or edit on any other files. Those are blocked.`;
      return { systemPrompt: event.systemPrompt + injection };
    }

    if (currentMode === "acceptEdits") {
      const injection =
        `\n\n[ACCEPT EDITS MODE] File edits and safe filesystem commands are auto-approved. Proceed efficiently.`;
      return { systemPrompt: event.systemPrompt + injection };
    }

    return {};
  });

  // ── Tool permission gating ─────────────────────────────────

  pi.on("tool_call", async (event, ctx) => {
    // PLAN MODE — block writes/edits; gate bash to read-only
    if (currentMode === "plan") {
      if (event.toolName === "write" || event.toolName === "edit") {
        const filePath = (event.input as any).file_path || (event.input as any).path || "unknown";
        if (isPlanFilePath(filePath, ctx.cwd)) {
          touchedPlanFiles.push(path.resolve(ctx.cwd, filePath));
          return {};
        }
        return {
          block: true,
          reason: `[PLAN MODE] ${event.toolName} is disabled. You may only use it for .pi/plans/*.md files.`,
        };
      }
      if (event.toolName === "bash") {
        const cmd = (event.input as { command: string }).command;
        if (!isReadonlyBash(cmd, config)) {
          return {
            block: true,
            reason: `[PLAN MODE] Only read-only bash commands are allowed.`,
          };
        }
      }
      return {}; // allow read, glob, grep, ls, and safe bash
    }

    // DEFAULT MODE — prompt before every stateful tool; allow read-only bash silently
    if (currentMode === "default") {
      if (event.toolName === "write" || event.toolName === "edit") {
        if (!ctx.hasUI) return {};
        const filePath =
          (event.input as any).file_path || (event.input as any).path || "unknown";
        const ok = await ctx.ui.confirm("Confirm change", `Allow ${event.toolName} on ${filePath}?`);
        if (!ok) return { block: true, reason: "Denied by user" };
      }
      if (event.toolName === "bash") {
        const cmd = (event.input as { command: string }).command;
        if (isReadonlyBash(cmd, config)) return {}; // allow silently
        if (!ctx.hasUI) return {};
        const ok = await ctx.ui.confirm("Confirm command", `Allow: ${cmd}?`);
        if (!ok) return { block: true, reason: "Denied by user" };
      }
      return {};
    }

    // ACCEPT EDITS MODE — auto-approve write/edit, gate bash
    if (currentMode === "acceptEdits") {
      if (event.toolName === "bash") {
        const cmd = (event.input as { command: string }).command;
        if (!isSafeBash(cmd, config) && !isReadonlyBash(cmd, config)) {
          if (!ctx.hasUI) return {};
          const ok = await ctx.ui.confirm("Confirm command", `Allow: ${cmd}?`);
          if (!ok) return { block: true, reason: "Denied by user" };
        }
      }
      return {};
    }

    return {};
  });

  // ── Capture plan on completion ─────────────────────────────

  pi.on("agent_end", async (event, ctx) => {
    if (currentMode !== "plan") return;
    if (!ctx.hasUI) return;

    let planFilePath: string;

    if (touchedPlanFiles.length > 0) {
      planFilePath = touchedPlanFiles[touchedPlanFiles.length - 1];
      ctx.ui.notify(`Plan file ready: ${path.relative(ctx.cwd, planFilePath)}`, "success");
    } else {
      const messages = event.messages;
      const lastAssistant = [...messages].reverse().find((m) => m.role === "assistant");
      if (!lastAssistant) return;

      const planText = lastAssistant.content
        .filter((c): c is { type: "text"; text: string } => c.type === "text")
        .map((c) => c.text)
        .join("\n")
        .trim();

      if (!planText) return;

      const plansDir = path.join(ctx.cwd, ".pi", "plans");
      fs.mkdirSync(plansDir, { recursive: true });

      const filename = generatePlanFilename();
      planFilePath = path.join(plansDir, filename);

      const meta = {
        created: new Date().toISOString(),
        mode: "plan",
        session: ctx.sessionManager.getSessionFile() || "ephemeral",
      };

      fs.writeFileSync(planFilePath, buildPlanFile(planText, meta), "utf-8");
      ctx.ui.notify(`Plan saved to ${path.relative(ctx.cwd, planFilePath)}`, "success");
    }

    // Approval dialog
    const choice = await ctx.ui.select("The plan is ready to execute. Would you like to proceed?", [
      "1. Auto-accept edits",
      "2. Manually approve edits",
      "3. Provide further feedback",
    ]);

    if (choice === "1. Auto-accept edits") {
      currentMode = "acceptEdits";
      persistMode(pi, "acceptEdits");
      ctx.ui.setStatus("pledit", statusLabel(currentMode));
      pi.sendUserMessage(
        `Implement the approved plan from ${planFilePath}. Execute all steps without stopping for confirmation.`,
        { deliverAs: "followUp" }
      );
    } else if (choice === "2. Manually approve edits") {
      currentMode = "default";
      persistMode(pi, "default");
      ctx.ui.setStatus("pledit", statusLabel(currentMode));
      pi.sendUserMessage(
        `Implement the approved plan from ${planFilePath}. Ask for confirmation before each file edit or shell command.`,
        { deliverAs: "followUp" }
      );
    } else {
      // "3. Provide further feedback" or dialog dismissed — remain in plan mode
      return;
    }
  });
}
