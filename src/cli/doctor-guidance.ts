export function bridgeRuntimeMismatchGuidance(workspaceRoot: string, tunnelConfigured: boolean): string {
  const command = `c2c restart -w "${workspaceRoot}"${tunnelConfigured ? " --tunnel" : ""}`;
  return `运行记录与当前 Bridge 不匹配。请运行：${command}`;
}
