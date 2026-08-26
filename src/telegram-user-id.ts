const POSTGRES_BIGINT_MAX = '9223372036854775807';

export function isPositivePostgresBigint(value: string): boolean {
  return /^[1-9]\d*$/.test(value)
    && (
      value.length < POSTGRES_BIGINT_MAX.length
      || (value.length === POSTGRES_BIGINT_MAX.length && value <= POSTGRES_BIGINT_MAX)
    );
}
