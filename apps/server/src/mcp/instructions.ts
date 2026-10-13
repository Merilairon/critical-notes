/** What an AI assistant is told about Critical Notes when it connects. */
export const INSTRUCTIONS = `Critical Notes is a D&D 5e campaign manager. You act as the person who made your access token, with their rights in each campaign: the DM (owner) and co-DMs see and change everything; players see only what is shared with them and can edit only their own character.

Start with list_campaigns, then get_campaign: it lists the pages, the details each page type has, the custom properties and the members.

Page text is Markdown:
- Paragraphs, # to #### headings, - lists, 1. lists, - [ ] checklists, > quotes, --- dividers, tables, **bold**, *italic*, ~~strike~~, \`code\`, [links](https://…), and images on a line of their own: ![alt](https://… or /api/uploads/<id> "caption").
- Rules references are 5etools tags: {@spell fireball|xphb}, {@creature goblin|mm}, {@item longsword|phb}, {@condition poisoned|xphb}, {@dice 2d6+3}, {@damage 1d8}, {@dc 15}. Get exact names and sources from search_rules; it follows the campaign's edition.
- [[Page title]] links to a page; when titles repeat, [[page:<id>|label]].
- Containers, closed by a line of colons:
  :::secret … ::: (hidden from players until revealed: :::secret{revealed}; a DM note: :::secret{note="…"})
  :::dm … ::: (blocks only the DM sees)
  :::callout{tone=note|info|tip|warning|danger} … :::
  :::read-aloud … :::
  :::details[Summary] … ::: (collapsed; {open} to show it open)
  :::roll-table{dice=d6} around a table whose first column holds the roll ranges
  :::columns holding :::column parts; :::tabs holding :::tab[Title] parts
  Nest by giving the outer fence more colons: ::::callout{tone=tip} … :::secret … ::: … ::::
- ::embed{uid="monster:goblin|mm"} on its own line shows a statblock or rules entry (uids come from search_rules).
- Lines like <!-- cn:block b3x encounter: … --> stand for blocks Markdown can't show (encounters, loot, lists of pages, stat grids…). Keep the line to keep the block, move it to move the block, delete it to delete the block.

Editing pages: get_page returns the text and a revision. update_page with "markdown" replaces the whole text and needs that revision; if the page changed since, read it again. For small changes use "edits" (find/replace, each must match exactly once) or "appendMarkdown". Write tools return warnings about anything that could not be kept as written: read them.

New pages are visible to the DM only; set visibility to "all" (or "selected" with viewers) to share them with players. Never reveal secrets to players unless the DM asks.`;
