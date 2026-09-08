export type ProviderId = 'openrouter';

export interface Config {
  provider: ProviderId;
  apiKey: string;
}

export interface ModelTab {
  id: number;
  title: string;
  url: string;
}

export interface GroupPlan {
  name: string;
  tabIds: number[];
}

export interface LastError {
  message: string;
  timestamp: number;
}

export type ChatMessage = {
  role: 'system' | 'user' | 'assistant';
  content: string;
};

export interface ChatResult {
  content: string;
  model: string;
}

export interface ParseResult {
  plans: GroupPlan[];
  errors: string[];
}

export interface ApplyReport {
  applied: number;
  skipped: number;
  failed: number;
  failures: string[];
}
