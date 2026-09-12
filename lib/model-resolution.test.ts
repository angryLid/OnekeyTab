import { describe, expect, it } from 'vitest';
import { PROVIDERS, MODEL_ID_MAX, isValidModelId, resolveModel } from './constants';

describe('resolveModel', () => {
  it('returns the built-in default for undefined', () => {
    expect(resolveModel(undefined)).toBe(PROVIDERS.openrouter.model);
  });

  it('returns the built-in default for empty and whitespace-only values', () => {
    expect(resolveModel('')).toBe(PROVIDERS.openrouter.model);
    expect(resolveModel('   ')).toBe(PROVIDERS.openrouter.model);
  });

  it('returns a trimmed configured override', () => {
    expect(resolveModel('  openai/gpt-5-mini ')).toBe('openai/gpt-5-mini');
  });
});

describe('isValidModelId', () => {
  it('accepts a typical OpenRouter id', () => {
    expect(isValidModelId('google/gemini-3.5-flash-lite')).toBe(true);
  });

  it('rejects empty values (empty means "use default", not an id)', () => {
    expect(isValidModelId('')).toBe(false);
  });

  it('rejects whitespace inside the id', () => {
    expect(isValidModelId('google gemini')).toBe(false);
  });

  it('rejects ids beyond the length cap', () => {
    expect(isValidModelId('a'.repeat(MODEL_ID_MAX + 1))).toBe(false);
    expect(isValidModelId('a'.repeat(MODEL_ID_MAX))).toBe(true);
  });
});
