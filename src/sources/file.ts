import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { formatZodIssues, TicketValidationError } from "../domain/errors.js";
import { type Ticket, TicketSchema } from "../domain/schemas.js";
import type { TicketSource } from "./ticket-source.js";

export interface FileTicketSourceOptions {
  /** Directory of `*.json` files, one Ticket per file. Filenames are not ids. */
  ticketsDir: string;
  /** JSON array of open tickets (the duplicate-detection corpus). */
  corpusFile?: string;
}

// SPEC §6.3. Reads tickets from local JSON fixtures.
export class FileTicketSource implements TicketSource {
  readonly #ticketsDir: string;
  readonly #corpusFile: string | undefined;

  constructor({ ticketsDir, corpusFile }: FileTicketSourceOptions) {
    this.#ticketsDir = ticketsDir;
    this.#corpusFile = corpusFile;
  }

  async getTicket(id: string): Promise<Ticket> {
    const files = (await readdir(this.#ticketsDir)).filter((f) => f.endsWith(".json")).sort();
    for (const file of files) {
      const path = join(this.#ticketsDir, file);
      let data: unknown;
      try {
        data = JSON.parse(await readFile(path, "utf8"));
      } catch {
        continue; // unreadable JSON cannot be matched by id
      }
      if (!isObject(data) || String(data.id) !== id) continue;
      const result = TicketSchema.safeParse(data);
      if (!result.success) {
        const { issues } = result.error;
        throw new TicketValidationError(issues, `Invalid ticket ${id} in ${path}: ${formatZodIssues(issues)}`);
      }
      return result.data;
    }
    throw new Error(`Ticket ${id} not found in ${this.#ticketsDir}`);
  }

  async listOpenTickets(): Promise<Ticket[]> {
    if (this.#corpusFile === undefined) return [];
    const data: unknown = JSON.parse(await readFile(this.#corpusFile, "utf8"));
    return TicketSchema.array().parse(data);
  }
}

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);
