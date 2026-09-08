/**
 * Type definitions for OpenCode (@opencode-ai/plugin) in-process plugin API.
 */

export interface PluginInput {
  client: any;
  project: any;
  directory: string;
  worktree?: string;
  $: any;
}

export interface ChatMessagePart {
  type: string;
  text?: string;
  [key: string]: any;
}

export interface ChatMessageOutput {
  parts: ChatMessagePart[];
}

export interface SystemTransformOutput {
  system: string[];
}

export interface CompactingOutput {
  context: string[];
}

export interface ToolExecuteAfterInput {
  tool: string;
  sessionID?: string;
  [key: string]: any;
}

export interface ToolExecuteAfterOutput {
  title?: string;
  output?: string;
  [key: string]: any;
}

export interface PluginEvent {
  type: string;
  properties?: any;
}

export interface OpenCodeHooks {
  config?: (cfg: any) => void | Promise<void>;
  'experimental.chat.system.transform'?: (input: any, output: SystemTransformOutput) => void | Promise<void>;
  'chat.message'?: (input: any, output: ChatMessageOutput) => void | Promise<void>;
  'tool.execute.after'?: (input: ToolExecuteAfterInput, output: ToolExecuteAfterOutput) => void | Promise<void>;
  'experimental.session.compacting'?: (input: any, output: CompactingOutput) => void | Promise<void>;
  event?: (args: { event: PluginEvent }) => void | Promise<void>;
  dispose?: () => void | Promise<void>;
}

export type OpenCodePlugin = (input: PluginInput) => Promise<OpenCodeHooks>;
