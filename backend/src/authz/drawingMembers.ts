import type { PrismaClient } from "../generated/client";
import { getDrawingRosters, type RosterMember } from "./roster";
import { subjectKey } from "./subjectKey";
import { derivePresenceColor, toPresenceInitials } from "../server/socketPresence";

/** Enough for a row of faces. More than a dozen is a list, not a row. */
const MAX_CARD_MEMBERS = 12;

export type DrawingMemberProjection = {
  subjectKey: string;
  name: string;
  initials: string;
  color: string;
  kind: "owner" | "member";
  isSelf: boolean;
};

export type DrawingMembersProjection = {
  totalCount: number;
  items: DrawingMemberProjection[];
};

const project = (
  member: RosterMember,
  params: { secret: string; drawingId: string; viewerId: string },
): DrawingMemberProjection => ({
  subjectKey: subjectKey(params.secret, `drawing:${params.drawingId}`, member.userId),
  name: member.name,
  initials: toPresenceInitials(member.name),
  color: derivePresenceColor(member.userId),
  kind: member.level === "owner" ? "owner" : "member",
  isSelf: member.userId === params.viewerId,
});

/**
 * The people to show on a board's card, keyed the same way presence is keyed so
 * the two can be matched without either side carrying an account id.
 *
 * Guests are absent by design: someone holding a share link has no standing
 * claim on the board, and listing them would turn a forwarded link into a name
 * on a card. They appear only while they are actually connected, as a count.
 */
export const getDrawingMemberProjections = async (params: {
  prisma: PrismaClient;
  drawingIds: readonly string[];
  viewerId: string;
  secret: string;
}): Promise<Map<string, DrawingMembersProjection>> => {
  const rosters = await getDrawingRosters({
    prisma: params.prisma,
    drawingIds: params.drawingIds,
  });
  const projections = new Map<string, DrawingMembersProjection>();
  for (const [drawingId, members] of rosters) {
    projections.set(drawingId, {
      totalCount: members.length,
      items: members
        .slice(0, MAX_CARD_MEMBERS)
        .map((member) =>
          project(member, { secret: params.secret, drawingId, viewerId: params.viewerId }),
        ),
    });
  }
  return projections;
};
