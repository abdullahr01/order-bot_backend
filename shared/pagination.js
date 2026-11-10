const positive = (value, fallback) => (Number.isInteger(Number(value)) && Number(value) > 0 ? Number(value) : fallback);

/** Works out the page once the total is known. A page past the end shows the last page. */
export function pageWindow(total, query, { defaultSize = 25, maxSize = 100 } = {}) {
  const pageSize = Math.min(positive(query.pageSize, defaultSize), maxSize);
  const pageCount = Math.max(1, Math.ceil(total / pageSize));
  const page = Math.min(positive(query.page, 1), pageCount);
  return { page, pageSize, pageCount, offset: (page - 1) * pageSize };
}

export const paginated = (items, total, { page, pageSize, pageCount }) => ({ items, total, page, pageSize, pageCount });
