export const LISTING_PROGRAM = 'ps'
export const LISTING_COLUMNS: readonly string[] = ['-Ao', 'pid=,ppid=,pgid=,lstart=,args=']
export const LISTING_COMMAND = [LISTING_PROGRAM, ...LISTING_COLUMNS].join(' ')
