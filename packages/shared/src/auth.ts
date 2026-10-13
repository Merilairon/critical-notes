import { z } from 'zod';

export const usernameSchema = z
  .string()
  .trim()
  .min(2)
  .max(40)
  .regex(/^[a-zA-Z0-9_.-]+$/, 'Letters, numbers, dots, dashes and underscores only');
export const passwordSchema = z.string().min(8, 'At least 8 characters').max(200);

export const loginInput = z.object({ username: z.string().trim().min(1).max(40), password: z.string().min(1).max(200) });
export type LoginInput = z.infer<typeof loginInput>;

export const setupInput = z.object({ username: usernameSchema, displayName: z.string().trim().min(1).max(80), password: passwordSchema });
export type SetupInput = z.infer<typeof setupInput>;

export const changePasswordInput = z.object({ currentPassword: z.string().min(1).max(200), newPassword: passwordSchema });

export interface UserDto {
  id: string;
  username: string;
  displayName: string;
  isAdmin: boolean;
}

export interface MeDto {
  user: UserDto | null;
  setupRequired: boolean;
}
