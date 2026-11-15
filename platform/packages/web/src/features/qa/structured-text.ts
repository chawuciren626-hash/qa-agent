/** Show numbered items in generated prose on separate lines without changing saved artifacts. */
export function breakNumberedItems(value: string): string {
  if (!/^\s*1[.、．](?!\d)/.test(value) || !/(?:[；;，,。]\s*|\s+)2[.、．](?!\d)/.test(value)) return value;
  return value.replace(/(?:[；;，,。]\s*|\s+)(?=\d+[.、．](?!\d))/g, "\n");
}
