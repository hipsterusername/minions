// Existing list API: implement the status option without breaking pagination.
export function list(records, { page = 0, pageSize = 20 } = {}) {
  if (!Number.isSafeInteger(page) || page < 0 || !Number.isSafeInteger(pageSize) || pageSize <= 0) throw new RangeError('page');
  return records.slice(page * pageSize, (page + 1) * pageSize);
}
