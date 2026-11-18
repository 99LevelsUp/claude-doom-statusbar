# Game asset packages

Each folder here is the source of one npm package, `@claude-game-bar/<game>`: the assets of one
game, published apart from the bar. The bar itself (`claude-game-bar`) ships no game assets. An
installed bar downloads the version its game manifest pins, the first time a skin needs it, and
removes it after 30 days unused. A checkout of this repository uses these folders directly and
installs nothing.

The rest of a game is in `src/games/<game>/`: its manifest (`game.toml`, which pins this package's
version and integrity) and its bundled skins. That part ships with the bar.

## Structure

```
packages/<game>/
  package.json      name @claude-game-bar/<game>, version, and the folders it publishes
  images/           pictures the skins draw, such as the DOOM mugshot frames
  scripts/          skin scripts, such as the mugshot's frame choice or the hotbar highlight
  conversations/    conversation libraries for the chat element
```

A game has only the folders it needs. A skin names an asset by game and path inside the package,
for example `doom:images/mugshot/STFST01.png`.

| Folder | Package | What it holds |
|---|---|---|
| `doom/` | `@claude-game-bar/doom` | the mugshot frames (DOOM status-face sprites) and the script that picks a frame |
| `minecraft/` | `@claude-game-bar/minecraft` | the hotbar highlight script and the Minecraft chat's conversation library |

## Changing a package

A changed package needs a new version, the same version in its game's `game.toml`, a publish from
`master` by `.github/workflows/publish-assets.yml` and then the new integrity pinned in the manifest.
The steps are in [CONTRIBUTING.md, *Asset packages*](../CONTRIBUTING.md#asset-packages).
