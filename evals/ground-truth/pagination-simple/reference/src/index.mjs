export function paginate(items, page, pageSize) {
  if (!Number.isSafeInteger(page) || page < 0 || !Number.isSafeInteger(pageSize) || pageSize <= 0) {
    throw new RangeError('page must be nonnegative and pageSize positive safe integers');
  }
  return items.slice(page * pageSize, (page + 1) * pageSize);
}
