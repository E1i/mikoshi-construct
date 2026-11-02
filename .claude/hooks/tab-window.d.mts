export declare const CARD_VARIABLE: string
export declare const ENTRYPOINT_VARIABLE: string
export declare const HEADLESS_ENTRYPOINT: string
export declare const WORKTREE_HOME_VARIABLE: string
export declare const DEFAULT_WORKTREE_HOME: string
export declare function worktreeHome(env: NodeJS.ProcessEnv): string
export declare function worktreeHomesOf(env: NodeJS.ProcessEnv): string[]
export declare function underTheLoop(env: NodeJS.ProcessEnv): boolean
export declare function isCardSession(env: NodeJS.ProcessEnv): boolean
export declare function tabCandidate(env: NodeJS.ProcessEnv): boolean
export declare function inCardTree(dir: string, treeHomes: readonly string[]): boolean
export declare function isTabWindowIn(env: NodeJS.ProcessEnv, dir: string, treeHomes: readonly string[]): boolean
