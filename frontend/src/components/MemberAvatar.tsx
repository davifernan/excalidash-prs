import React from "react";
import clsx from "clsx";

type MemberAvatarProps = {
  name: string;
  initials: string;
  color: string;
  size?: number;
  /** Someone who has access but is not on the board right now. */
  dimmed?: boolean;
  /** Someone who has the board open right now. */
  online?: boolean;
  title?: string;
};

const MemberAvatar: React.FC<MemberAvatarProps> = ({
  name,
  initials,
  color,
  size = 28,
  dimmed = false,
  online = false,
  title,
}) => (
  <div
    title={title ?? name}
    aria-label={title ?? name}
    data-testid="member-avatar"
    data-online={online ? "true" : "false"}
    className={clsx(
      "relative flex items-center justify-center rounded-full border-2 border-black dark:border-neutral-900 font-black text-white select-none transition-all duration-200",
      dimmed && "opacity-40 saturate-50",
      online &&
        "ring-2 ring-emerald-400 ring-offset-1 ring-offset-white dark:ring-offset-neutral-900",
    )}
    style={{
      width: size,
      height: size,
      backgroundColor: color,
      fontSize: Math.max(9, Math.round(size * 0.36)),
    }}
  >
    {initials}
  </div>
);

type MemberStackProps = {
  members: { subjectKey: string; name: string; initials: string; color: string }[];
  /** Keys of the people currently connected, or null while that is unknown. */
  onlineKeys?: ReadonlySet<string> | null;
  max?: number;
  size?: number;
};

export const MemberStack: React.FC<MemberStackProps> = ({
  members,
  onlineKeys = null,
  max = 6,
  size = 28,
}) => {
  const shown = members.slice(0, max);
  const overflow = members.length - shown.length;
  return (
    <div className="flex items-center">
      {shown.map((member, index) => (
        <div key={member.subjectKey} style={{ marginLeft: index === 0 ? 0 : -8 }}>
          <MemberAvatar
            name={member.name}
            initials={member.initials}
            color={member.color}
            size={size}
            // Until presence is known, nobody is dimmed: a row of greyed-out
            // faces would claim that everyone is away, which is not something
            // the page knows yet.
            dimmed={onlineKeys ? !onlineKeys.has(member.subjectKey) : false}
            online={onlineKeys ? onlineKeys.has(member.subjectKey) : false}
          />
        </div>
      ))}
      {overflow > 0 && (
        <div
          style={{
            marginLeft: -8,
            width: size,
            height: size,
            fontSize: Math.max(9, Math.round(size * 0.34)),
          }}
          className="flex items-center justify-center rounded-full border-2 border-black dark:border-neutral-900 bg-slate-200 dark:bg-neutral-700 font-black text-slate-700 dark:text-neutral-200"
          title={`${overflow} more`}
        >
          +{overflow}
        </div>
      )}
    </div>
  );
};
