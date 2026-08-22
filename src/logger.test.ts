import { describe, expect, it } from 'vitest';
import { safeErrorMetadata } from './logger.js';

describe('safeErrorMetadata', () => {
  it('keeps safe PostgreSQL and system error codes without serializing the message', () => {
    const postgresError = Object.assign(new Error('password authentication failed'), {
      code: '28P01',
    });
    const networkError = Object.assign(new Error('connect refused'), {
      code: 'ECONNREFUSED',
    });

    expect(safeErrorMetadata(postgresError)).toEqual({
      errorClass: 'Error',
      code: '28P01',
    });
    expect(safeErrorMetadata(networkError)).toEqual({
      errorClass: 'Error',
      code: 'ECONNREFUSED',
    });
  });

  it('drops arbitrary error codes that could contain provider-controlled text', () => {
    const error = Object.assign(new Error('secret'), {
      code: 'secret-content',
      status: 502,
    });

    expect(safeErrorMetadata(error)).toEqual({
      errorClass: 'Error',
      status: 502,
    });
  });
});
