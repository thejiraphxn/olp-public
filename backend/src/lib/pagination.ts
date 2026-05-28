import { z } from 'zod';

export const pageSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  q: z.string().max(80).optional(),
});

export type Page = z.infer<typeof pageSchema>;

export function toPaginated<T>(items: T[], total: number, page: Page) {
  return {
    items,
    total,
    page: page.page,
    limit: page.limit,
    totalPages: Math.max(1, Math.ceil(total / page.limit)),
  };
}
