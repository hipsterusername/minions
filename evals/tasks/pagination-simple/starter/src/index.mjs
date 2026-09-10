// Repair the boundary and validation bugs in this editable library.
export function paginate(items, page, pageSize) {
  return items.slice(page * pageSize + 1, (page + 1) * pageSize + 1);
}
