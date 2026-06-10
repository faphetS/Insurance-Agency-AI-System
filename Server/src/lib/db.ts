import { Pool } from "pg";
import { env } from "../config/env.js";
import { logger } from "../config/logger.js";

export const pool = new Pool({
  connectionString: env.DATABASE_URL,
  max: env.DATABASE_POOL_MAX,
});

pool.on("error", (err) => {
  logger.error({ err }, "pg: unexpected pool error");
});

// ---------------------------------------------------------------------------
// Return shape (mirrors supabase-js)
// ---------------------------------------------------------------------------

export interface DbResult<T = any> {
  data: T | null;
  error: { message: string; code?: string; details?: string } | null;
  count: number | null;
}

// ---------------------------------------------------------------------------
// Internal query state
// ---------------------------------------------------------------------------

type MutationKind = "insert" | "update" | "delete" | "upsert";

interface SelectOpts {
  count?: "exact";
  head?: boolean;
}

interface UpsertOpts {
  onConflict?: string;
  ignoreDuplicates?: boolean;
}

interface OrderOpt {
  col: string;
  ascending: boolean;
}

interface Filter {
  type:
    | "eq"
    | "neq"
    | "gt"
    | "gte"
    | "lt"
    | "lte"
    | "in"
    | "like"
    | "ilike"
    | "is"
    | "not"
    | "or";
  col: string;
  op?: string;
  val: any;
}

// ---------------------------------------------------------------------------
// SQL helpers
// ---------------------------------------------------------------------------

function quoteIdent(name: string): string {
  // Allow schema-qualified names like "public"."table" and view names
  return name
    .split(".")
    .map((part) => `"${part.replace(/"/g, '""')}"`)
    .join(".");
}

function opToSql(op: string): string {
  switch (op) {
    case "eq":
      return "=";
    case "neq":
      return "!=";
    case "gt":
      return ">";
    case "gte":
      return ">=";
    case "lt":
      return "<";
    case "lte":
      return "<=";
    default:
      return "=";
  }
}

// Parse PostgREST filter string: "col.op.val,col2.op2.val2"
// Supports: is(null), eq, neq, gt, gte, lt, lte, in(val1|val2)
function parseOrString(
  filterStr: string,
  params: any[],
): string {
  const parts = filterStr.split(",").map((s) => s.trim());
  const clauses: string[] = [];

  for (const part of parts) {
    // Split on first two dots only so values like dates with no dots are fine
    const dotIdx1 = part.indexOf(".");
    if (dotIdx1 === -1) continue;
    const col = part.slice(0, dotIdx1);
    const rest = part.slice(dotIdx1 + 1);
    const dotIdx2 = rest.indexOf(".");
    const op = dotIdx2 === -1 ? rest : rest.slice(0, dotIdx2);
    const rawVal = dotIdx2 === -1 ? "" : rest.slice(dotIdx2 + 1);

    const qCol = quoteIdent(col);

    if (op === "is") {
      if (rawVal === "null") {
        clauses.push(`${qCol} IS NULL`);
      } else if (rawVal === "true") {
        clauses.push(`${qCol} IS TRUE`);
      } else if (rawVal === "false") {
        clauses.push(`${qCol} IS FALSE`);
      }
    } else if (op === "in") {
      // e.g. in.(val1,val2) — strip wrapping parens if present
      const inner = rawVal.replace(/^\(|\)$/g, "");
      const vals = inner.split("|").map((v) => v.trim());
      const placeholders = vals.map((v) => {
        params.push(v);
        return `$${params.length}`;
      });
      clauses.push(`${qCol} IN (${placeholders.join(",")})`);
    } else {
      params.push(rawVal);
      clauses.push(`${qCol} ${opToSql(op)} $${params.length}`);
    }
  }

  return clauses.length > 0 ? `(${clauses.join(" OR ")})` : "TRUE";
}

// ---------------------------------------------------------------------------
// QueryBuilder
// ---------------------------------------------------------------------------

export class QueryBuilder {
  private _table: string;

  // mutation state
  private _mutationKind: MutationKind | null = null;
  private _mutationValues: any | any[] | null = null;
  private _upsertOpts: UpsertOpts | null = null;
  private _hasChainedSelect = false;

  // select state
  private _selectCols = "*";
  private _selectOpts: SelectOpts = {};

  // filter state
  private _filters: Filter[] = [];

  // modifier state
  private _orders: OrderOpt[] = [];
  private _limit: number | null = null;
  private _offset: number | null = null;
  private _isSingle = false;
  private _isMaybeSingle = false;

  // lazy execution cache
  private _promise: Promise<DbResult<any>> | null = null;

  constructor(table: string) {
    this._table = table;
  }

  // -------------------------------------------------------------------------
  // Query starters
  // -------------------------------------------------------------------------

  select(columns = "*", opts: SelectOpts = {}): this {
    if (this._mutationKind !== null) {
      // Chained .select() after insert/update/upsert — request RETURNING *
      this._hasChainedSelect = true;
      return this;
    }
    this._selectCols = columns;
    this._selectOpts = opts;
    return this;
  }

  insert(values: any | any[]): this {
    this._mutationKind = "insert";
    this._mutationValues = values;
    return this;
  }

  update(values: any): this {
    this._mutationKind = "update";
    this._mutationValues = values;
    return this;
  }

  delete(): this {
    this._mutationKind = "delete";
    return this;
  }

  upsert(values: any | any[], opts: UpsertOpts = {}): this {
    this._mutationKind = "upsert";
    this._mutationValues = values;
    this._upsertOpts = opts;
    return this;
  }

  // -------------------------------------------------------------------------
  // Filters (all return this for chaining)
  // -------------------------------------------------------------------------

  eq(col: string, val: any): this {
    this._filters.push({ type: "eq", col, val });
    return this;
  }

  neq(col: string, val: any): this {
    this._filters.push({ type: "neq", col, val });
    return this;
  }

  gt(col: string, val: any): this {
    this._filters.push({ type: "gt", col, val });
    return this;
  }

  gte(col: string, val: any): this {
    this._filters.push({ type: "gte", col, val });
    return this;
  }

  lt(col: string, val: any): this {
    this._filters.push({ type: "lt", col, val });
    return this;
  }

  lte(col: string, val: any): this {
    this._filters.push({ type: "lte", col, val });
    return this;
  }

  in(col: string, vals: any[]): this {
    this._filters.push({ type: "in", col, val: vals });
    return this;
  }

  like(col: string, pattern: string): this {
    this._filters.push({ type: "like", col, val: pattern });
    return this;
  }

  ilike(col: string, pattern: string): this {
    this._filters.push({ type: "ilike", col, val: pattern });
    return this;
  }

  is(col: string, val: null | true | false): this {
    this._filters.push({ type: "is", col, val });
    return this;
  }

  not(col: string, op: string, val: any): this {
    this._filters.push({ type: "not", col, op, val });
    return this;
  }

  or(filterString: string): this {
    this._filters.push({ type: "or", col: "", val: filterString });
    return this;
  }

  // -------------------------------------------------------------------------
  // Modifiers
  // -------------------------------------------------------------------------

  order(col: string, opts: { ascending?: boolean } = {}): this {
    this._orders.push({ col, ascending: opts.ascending !== false });
    return this;
  }

  limit(n: number): this {
    this._limit = n;
    return this;
  }

  range(from: number, to: number): this {
    this._limit = to - from + 1;
    this._offset = from;
    return this;
  }

  single(): this {
    this._isSingle = true;
    return this;
  }

  maybeSingle(): this {
    this._isMaybeSingle = true;
    return this;
  }

  // -------------------------------------------------------------------------
  // WHERE clause builder
  // -------------------------------------------------------------------------

  private buildWhere(params: any[]): string {
    if (this._filters.length === 0) return "";

    const clauses: string[] = [];

    for (const f of this._filters) {
      const qCol = f.type === "or" ? "" : quoteIdent(f.col);

      switch (f.type) {
        case "eq":
          if (f.val === null) {
            clauses.push(`${qCol} IS NULL`);
          } else {
            params.push(f.val);
            clauses.push(`${qCol} = $${params.length}`);
          }
          break;

        case "neq":
          if (f.val === null) {
            clauses.push(`${qCol} IS NOT NULL`);
          } else {
            params.push(f.val);
            clauses.push(`${qCol} != $${params.length}`);
          }
          break;

        case "gt":
          params.push(f.val);
          clauses.push(`${qCol} > $${params.length}`);
          break;

        case "gte":
          params.push(f.val);
          clauses.push(`${qCol} >= $${params.length}`);
          break;

        case "lt":
          params.push(f.val);
          clauses.push(`${qCol} < $${params.length}`);
          break;

        case "lte":
          params.push(f.val);
          clauses.push(`${qCol} <= $${params.length}`);
          break;

        case "in": {
          const vals: any[] = f.val;
          if (vals.length === 0) {
            clauses.push("FALSE");
          } else {
            const placeholders = vals.map((v) => {
              params.push(v);
              return `$${params.length}`;
            });
            clauses.push(`${qCol} IN (${placeholders.join(", ")})`);
          }
          break;
        }

        case "like":
          params.push(f.val);
          clauses.push(`${qCol} LIKE $${params.length}`);
          break;

        case "ilike":
          params.push(f.val);
          clauses.push(`${qCol} ILIKE $${params.length}`);
          break;

        case "is":
          if (f.val === null) {
            clauses.push(`${qCol} IS NULL`);
          } else if (f.val === true) {
            clauses.push(`${qCol} IS TRUE`);
          } else {
            clauses.push(`${qCol} IS FALSE`);
          }
          break;

        case "not": {
          // Used as .not('col', 'is', null) → NOT (col IS NULL)
          const op = f.op ?? "is";
          if (op === "is") {
            if (f.val === null) {
              clauses.push(`${qCol} IS NOT NULL`);
            } else if (f.val === true) {
              clauses.push(`NOT (${qCol} IS TRUE)`);
            } else {
              clauses.push(`NOT (${qCol} IS FALSE)`);
            }
          } else {
            params.push(f.val);
            clauses.push(`NOT (${qCol} ${opToSql(op)} $${params.length})`);
          }
          break;
        }

        case "or": {
          const orClause = parseOrString(f.val as string, params);
          clauses.push(orClause);
          break;
        }
      }
    }

    return clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
  }

  // -------------------------------------------------------------------------
  // SQL builders
  // -------------------------------------------------------------------------

  private buildSelectSql(): { text: string; values: any[] } {
    const params: any[] = [];
    const where = this.buildWhere(params);
    const opts = this._selectOpts;

    const orderClause =
      this._orders.length > 0
        ? `ORDER BY ${this._orders
            .map((o) => `${quoteIdent(o.col)} ${o.ascending ? "ASC" : "DESC"}`)
            .join(", ")}`
        : "";

    let limitClause = "";
    let offsetClause = "";

    if (this._isSingle || this._isMaybeSingle) {
      // Honor an explicit .limit() — e.g. .limit(1).maybeSingle() means "first
      // match or null" and must NOT error when many rows match. Only fall back to
      // LIMIT 2 (ambiguity detection) when no explicit limit was chained.
      limitClause = this._limit !== null ? `LIMIT ${this._limit}` : "LIMIT 2";
    } else if (this._limit !== null) {
      limitClause = `LIMIT ${this._limit}`;
    }

    if (this._offset !== null && !this._isSingle && !this._isMaybeSingle) {
      offsetClause = `OFFSET ${this._offset}`;
    }

    const table = quoteIdent(this._table);

    if (opts.head) {
      // head:true → count only, no rows
      const text = [
        `SELECT count(*) AS _count FROM ${table}`,
        where,
      ]
        .filter(Boolean)
        .join(" ");
      return { text, values: params };
    }

    if (opts.count === "exact" && !this._isSingle && !this._isMaybeSingle) {
      // Return rows + a total count via window function
      const inner = `SELECT ${this._selectCols}, count(*) OVER() AS _total_count FROM ${table} ${where} ${orderClause} ${limitClause} ${offsetClause}`;
      return { text: inner.trim(), values: params };
    }

    const text = [
      `SELECT ${this._selectCols} FROM ${table}`,
      where,
      orderClause,
      limitClause,
      offsetClause,
    ]
      .filter(Boolean)
      .join(" ");

    return { text, values: params };
  }

  private buildMutationSql(): { text: string; values: any[] } {
    const params: any[] = [];
    const table = quoteIdent(this._table);
    const kind = this._mutationKind!;
    const returning = this._hasChainedSelect ? " RETURNING *" : "";

    if (kind === "insert") {
      const rows = Array.isArray(this._mutationValues)
        ? this._mutationValues
        : [this._mutationValues];

      if (rows.length === 0) {
        return { text: `INSERT INTO ${table} DEFAULT VALUES${returning}`, values: [] };
      }

      const cols = Object.keys(rows[0]!);
      const qCols = cols.map(quoteIdent).join(", ");

      const valuePlaceholders = rows.map((row) => {
        const ph = cols.map((c) => {
          params.push(row[c]);
          return `$${params.length}`;
        });
        return `(${ph.join(", ")})`;
      });

      const text = `INSERT INTO ${table} (${qCols}) VALUES ${valuePlaceholders.join(", ")}${returning}`;
      return { text, values: params };
    }

    if (kind === "update") {
      const cols = Object.keys(this._mutationValues);
      const setClauses = cols.map((c) => {
        params.push(this._mutationValues[c]);
        return `${quoteIdent(c)} = $${params.length}`;
      });

      const where = this.buildWhere(params);
      const text = `UPDATE ${table} SET ${setClauses.join(", ")} ${where}${returning}`.trim();
      return { text, values: params };
    }

    if (kind === "delete") {
      const where = this.buildWhere(params);
      const text = `DELETE FROM ${table} ${where}${returning}`.trim();
      return { text, values: params };
    }

    if (kind === "upsert") {
      const rows = Array.isArray(this._mutationValues)
        ? this._mutationValues
        : [this._mutationValues];

      if (rows.length === 0) {
        return { text: `INSERT INTO ${table} DEFAULT VALUES${returning}`, values: [] };
      }

      const opts = this._upsertOpts ?? {};
      const cols = Object.keys(rows[0]!);
      const qCols = cols.map(quoteIdent).join(", ");

      const valuePlaceholders = rows.map((row) => {
        const ph = cols.map((c) => {
          params.push(row[c]);
          return `$${params.length}`;
        });
        return `(${ph.join(", ")})`;
      });

      let onConflict = "";
      if (opts.onConflict) {
        if (opts.ignoreDuplicates) {
          onConflict = `ON CONFLICT (${quoteIdent(opts.onConflict)}) DO NOTHING`;
        } else {
          const updateCols = cols.filter((c) => c !== opts.onConflict);
          if (updateCols.length === 0) {
            onConflict = `ON CONFLICT (${quoteIdent(opts.onConflict)}) DO NOTHING`;
          } else {
            const updates = updateCols
              .map((c) => `${quoteIdent(c)} = EXCLUDED.${quoteIdent(c)}`)
              .join(", ");
            onConflict = `ON CONFLICT (${quoteIdent(opts.onConflict)}) DO UPDATE SET ${updates}`;
          }
        }
      }

      const text =
        `INSERT INTO ${table} (${qCols}) VALUES ${valuePlaceholders.join(", ")} ${onConflict}${returning}`.trim();
      return { text, values: params };
    }

    throw new Error(`QueryBuilder: unknown mutation kind "${kind}"`);
  }

  // -------------------------------------------------------------------------
  // Query executor
  // -------------------------------------------------------------------------

  private async execute(): Promise<DbResult<any>> {
    try {
      // ---- MUTATION path ----
      if (this._mutationKind !== null) {
        const { text, values } = this.buildMutationSql();

        if (!this._hasChainedSelect) {
          await pool.query(text, values);
          return { data: null, error: null, count: null };
        }

        const result = await pool.query(text, values);
        const rows = result.rows;

        if (this._isSingle) {
          if (rows.length !== 1) {
            return {
              data: null,
              error: {
                message:
                  rows.length === 0
                    ? "JSON object requested, multiple (or no) rows returned"
                    : "JSON object requested, multiple (or no) rows returned",
                code: "PGRST116",
                details: `Expected 1 row, got ${rows.length}`,
              },
              count: null,
            };
          }
          return { data: rows[0], error: null, count: null };
        }

        if (this._isMaybeSingle) {
          if (rows.length > 1) {
            return {
              data: null,
              error: {
                message: "JSON object requested, multiple rows returned",
                code: "PGRST116",
                details: `Expected 0 or 1 rows, got ${rows.length}`,
              },
              count: null,
            };
          }
          return { data: rows[0] ?? null, error: null, count: null };
        }

        return { data: rows, error: null, count: null };
      }

      // ---- SELECT path ----
      const { text, values } = this.buildSelectSql();
      const opts = this._selectOpts;

      if (opts.head) {
        const result = await pool.query(text, values);
        const totalCount = parseInt(result.rows[0]?._count ?? "0", 10);
        return { data: null, error: null, count: totalCount };
      }

      const result = await pool.query(text, values);
      let rows = result.rows;

      // Strip the injected _total_count column before returning
      let totalCount: number | null = null;
      if (opts.count === "exact" && rows.length > 0 && "_total_count" in rows[0]!) {
        totalCount = parseInt(rows[0]!._total_count as string, 10);
        rows = rows.map(({ _total_count: _ignored, ...rest }) => rest);
      } else if (opts.count === "exact") {
        totalCount = 0;
      }

      if (this._isSingle) {
        if (rows.length !== 1) {
          return {
            data: null,
            error: {
              message: "JSON object requested, multiple (or no) rows returned",
              code: "PGRST116",
              details: `Expected 1 row, got ${rows.length}`,
            },
            count: null,
          };
        }
        return { data: rows[0], error: null, count: null };
      }

      if (this._isMaybeSingle) {
        if (rows.length > 1) {
          return {
            data: null,
            error: {
              message: "JSON object requested, multiple rows returned",
              code: "PGRST116",
              details: `Expected 0 or 1 rows, got ${rows.length}`,
            },
            count: null,
          };
        }
        return { data: rows[0] ?? null, error: null, count: null };
      }

      return { data: rows, error: null, count: totalCount };
    } catch (err: any) {
      const pgErr = err as { message?: string; code?: string; detail?: string };
      return {
        data: null,
        error: {
          message: pgErr.message ?? String(err),
          code: pgErr.code,
          details: pgErr.detail,
        },
        count: null,
      };
    }
  }

  // -------------------------------------------------------------------------
  // PromiseLike — makes `await builder` work without a terminal call
  // -------------------------------------------------------------------------

  then<TResult1 = DbResult<any>, TResult2 = never>(
    onFulfilled?: ((value: DbResult<any>) => TResult1 | PromiseLike<TResult1>) | null,
    onRejected?: ((reason: any) => TResult2 | PromiseLike<TResult2>) | null,
  ): Promise<TResult1 | TResult2> {
    if (!this._promise) {
      this._promise = this.execute();
    }
    return this._promise.then(onFulfilled, onRejected);
  }
}

// ---------------------------------------------------------------------------
// Shim facade — mirrors supabaseAdmin.from(table)
// ---------------------------------------------------------------------------

export const supabaseAdmin = {
  from(table: string): QueryBuilder {
    return new QueryBuilder(table);
  },
};
