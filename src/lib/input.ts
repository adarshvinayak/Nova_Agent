import { z } from 'zod';
export const textInput=z.string().trim().min(1).max(8000);
export const uuid=z.string().uuid();
export const captureInput=z.object({text:textInput,source:z.enum(['typed','browser_voice','shortcut_dictation','share_text']),clientCaptureId:uuid}).strict();
export const turnInput=z.object({text:textInput,expectedVersion:z.number().int().positive(),clientTurnId:uuid}).strict();
export const factsInput=z.object({intent:z.enum(['appointment','note','unsupported','unclear']).optional(),title:z.string().trim().min(1).max(200).nullable().optional(),
  date:z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),time:z.string().regex(/^\d{2}:\d{2}$/).nullable().optional(),
  durationMinutes:z.number().int().min(1).max(1440).nullable().optional(),location:z.string().trim().min(1).max(300).nullable().optional(),locationNotApplicable:z.boolean().optional()}).strict();
export const editInput=z.object({facts:factsInput,expectedVersion:z.number().int().positive(),clientActionId:uuid}).strict();
export const noteInput=z.object({expectedVersion:z.number().int().positive(),clientActionId:uuid}).strict();
export const confirmInput=z.object({proposalVersion:z.number().int().positive(),snapshotHash:z.string().regex(/^[0-9a-f]{64}$/),idempotencyKey:uuid}).strict();
