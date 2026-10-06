import type { Ticket } from "../domain/schemas.js";

// SPEC §6.3. Read-only on purpose: no write path to any ticketing system.
export interface TicketSource {
  getTicket(id: string): Promise<Ticket>;
  listOpenTickets(): Promise<Ticket[]>;
}
