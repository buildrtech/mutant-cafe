interface Table { readonly fields: Readonly<Record<string, unknown>> }
type InsertModel<T extends Table> = T["fields"];
type RequiredKeys<T extends Table> = Extract<keyof InsertModel<T>, string>;
type Cols<TColumns extends PropertyKey[], TRequired extends string> = TColumns extends [] ? [] : [...TColumns, TRequired?];
interface Db {
  insert<
    TTable extends Table,
    TColumnList extends (keyof InsertModel<TTable>)[] = [],
    TRequiredKeys extends string = RequiredKeys<TTable>,
  >(table: TTable, ...columns: Cols<TColumnList, TRequiredKeys>): number;
}
declare const db: Db;
const insert = db.insert.bind(db);
export const guardedInsert: Db["insert"] = <
  TTable extends Table,
  TColumnList extends (keyof InsertModel<TTable>)[] = [],
  TRequiredKeys extends string = RequiredKeys<TTable>,
>(table: TTable, ...columns: Cols<TColumnList, TRequiredKeys>) => insert<TTable, TColumnList, TRequiredKeys>(table, ...columns);
export const healthy = (n: number): boolean => n > 0;
