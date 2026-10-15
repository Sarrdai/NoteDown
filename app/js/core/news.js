// News from the server's owner (docs/requirements.md → "News"): the feed is the
// same for everyone and unencrypted; what this user did with a post lives in
// `<!-- news … -->` markers of the private file, { id, seen, status? }: `seen`
// is the post's `modified` the user saw last, `status` "archived" or
// "deleted". A post edited since (`modified` ≠ `seen`) shows again as
// updated, whatever its status was. Markers of posts that left the feed go.

/** The circle key of the news in the people overview (no identity ID contains "@"). */
export const NEWS = "@news";

/**
 * The feed's posts ([{ id, created, modified, body }]) as read-only notes, deleted ones left out:
 * { id, status, created, modified, closed, due, body, news: true, fresh: "new" | "updated" | null }.
 */
export function newsNotes(posts, marks = []) {
  const byId = new Map(marks.map(m => [m.id, m]));
  return posts.flatMap(p => {
    const m = byId.get(p.id);
    const current = !!m && m.seen === p.modified;
    if (current && m.status === "deleted") return [];
    const archived = current && m.status === "archived";
    return [{
      id: p.id, status: archived ? "closed" : "open", created: p.created, modified: p.modified,
      closed: archived ? p.modified : null, due: null, body: p.body, news: true,
      fresh: !m ? "new" : current ? null : "updated",
    }];
  });
}

/** How many posts are new or updated. */
export const freshCount = notes => notes.filter(n => n.fresh).length;

/**
 * The markers after the user saw (`status` undefined) or archived, reopened or deleted posts `ids`
 * ("archived" | "open" | "deleted"): each takes the post's current `modified`; seeing an updated post
 * ends its old status. Ids that aren't in the feed are ignored.
 */
export function markNews(marks, posts, ids, status) {
  const out = new Map(marks.map(m => [m.id, m]));
  for (const p of posts.filter(x => ids.includes(x.id))) {
    const m = out.get(p.id);
    const kept = status === undefined ? (m && m.seen === p.modified ? m.status : undefined) : status === "open" ? undefined : status;
    out.set(p.id, { id: p.id, seen: p.modified, ...(kept && { status: kept }) });
  }
  return [...out.values()];
}

/** The markers without those of posts no longer in the feed (archived or deleted by the owner). */
export function pruneNews(marks, posts) {
  const ids = new Set(posts.map(p => p.id));
  return marks.filter(m => ids.has(m.id));
}
