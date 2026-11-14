---
name: wardrobe
description: The user's closet. Catalogue clothes, build outfits from what they own, save the good ones under styles.
---

# Wardrobe

Read with `read_addon`, write with `use_addon`, `addon: "wardrobe"`. Items and outfits have short refs (`i3k9q`, `o7mz2`); use them in every call. Start with `summary`.

## Rules

- Only use items that are in the closet. Never invent a garment, and never describe a photo you have not seen.
- Everything here is private to this user.

## Getting clothes in

You cannot pass a chat image to these tools. Photos come in through the dashboard (/addons/wardrobe) or `upload_link`, a link the user opens on their phone. One photo is one item. Items can also be added by description with `add_item`.

## Cataloguing

1. `review_queue` lists new photos that are not items yet, and items whose tags are drafts or missing.
2. `tag_pending` turns new photos into items, and drafts tags when the server has a vision model. If not, `view` each one, then `update_item` with name, category, colours, formality (1 lounge to 5 black tie), warmth (1 to 5), seasons and a one-sentence description.
3. Show the user the drafts (`view`) and ask about anything unclear: material, fit, where it lives. Fix with `update_item`, then `confirm_tags`.
4. Put what the user tells you in `notes`. Keep `location` current (`set_location`), and `status` (`set_status`: laundry, repair, stored, donated).

## Building outfits

1. Ask the occasion and the weather if the user has not said.
2. Read `styles` (rules and standing preferences) and the rejections in `summary`.
3. `list_items` with `status: "active"`, one `location`, and the season or formality that fits.
4. Propose about three outfits. For each, `view` with its item refs and show the sheet; the numbers match the list in the reply.
5. Save what the user likes with `save_outfit` under a style (new styles are created). For each one turned down, `save_outfit` with `verdict: "rejected"` and the reason, so it is not proposed again.
6. `log_wear` when the user wears one.

`save_outfit` refuses items that are not active, are in different places, or double up on shoes or bottoms. Fix the outfit rather than forcing it; use `allow_mixed_locations` only when the user says so.

## Styles and profile

A style is a named look with `do` and `dont` rules and a palette of plain colour names (`save_style`). Standing preferences that apply to everything ("nothing tight", "no logos") go in `set_profile`. Follow both when proposing, and add to them when the user explains a rejection that is a general rule.
