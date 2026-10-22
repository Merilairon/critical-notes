/** Personal API tokens for AI assistants (the MCP endpoint). */
import * as z from 'zod';

export const API_TOKEN_SCOPES = ['read', 'write'] as const;
export type ApiTokenScope = (typeof API_TOKEN_SCOPES)[number];

export const createApiTokenInput = z.object({
  name: z.string().trim().min(1).max(60),
  /** read: look things up only; write: also create, edit and delete. */
  scope: z.enum(API_TOKEN_SCOPES).default('read'),
  /** null: never expires. */
  expiresInDays: z.number().int().min(1).max(3650).nullable().default(90),
});
export type CreateApiTokenInput = z.infer<typeof createApiTokenInput>;

export interface ApiTokenDto {
  id: string;
  name: string;
  scope: ApiTokenScope;
  createdAt: number;
  lastUsedAt: number | null;
  expiresAt: number | null;
}

/** Returned once, when the token is made. */
export interface CreatedApiTokenDto extends ApiTokenDto {
  token: string;
}
