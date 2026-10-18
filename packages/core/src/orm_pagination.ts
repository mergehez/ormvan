export type PaginatedResult<T = any> = ReturnType<typeof createPagination<T>>;

export function createPagination<T>(rows: T[], total: number, currentPage: number, perPage: number) {
    const items = [...rows];
    return {
        get items() {
            return items;
        },
        total,
        currentPage,
        perPage,
        get lastPage() {
            return Math.max(Math.ceil(total / perPage), 1);
        },
        firstPage: 1,
        get hasPages() {
            return total > perPage;
        },
        get hasMorePages() {
            return currentPage < this.lastPage;
        },
        get isEmpty() {
            return items.length === 0;
        },
        get hasTotal() {
            return true;
        },
    };
}
