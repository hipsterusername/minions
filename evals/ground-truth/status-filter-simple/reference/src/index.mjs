export function list(records, { status, page = 0, pageSize = 20 } = {}) {
  if (status !== undefined && !['open', 'closed', 'pending'].includes(status)) throw new RangeError('status');
  if (!Number.isSafeInteger(page) || page < 0 || !Number.isSafeInteger(pageSize) || pageSize <= 0) throw new RangeError('page');
  return records.filter(record => status === undefined || record.status === status)
    .slice(page * pageSize, (page + 1) * pageSize);
}
