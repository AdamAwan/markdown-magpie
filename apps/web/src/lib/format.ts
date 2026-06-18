export function shortSha(value: string | undefined): string {
  return value ? value.slice(0, 12) : "Unknown";
}

export function formatQuestionCount(count: number): string {
  return `${count} question${count === 1 ? "" : "s"}`;
}
