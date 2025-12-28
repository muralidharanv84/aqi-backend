export interface EnvBindings {
  DB: D1Database;
}

export type Env = EnvBindings;

declare global {
  interface Env extends EnvBindings {}
}

export {};
