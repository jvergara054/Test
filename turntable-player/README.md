# Turntable player

A top-down technical drawing of a turntable, styled for sundaydrv.com, that plays the Sunday Drv Spotify playlist.
The Spotify player is hidden. The deck shows only what's playing: the song's cover art spins on the record label, and the strip underneath shows the title and progress.

![preview](preview.png)

_The preview uses a placeholder song and cover art._

Live: https://jvergara054.github.io/Test/turntable-player/

## Put it on sundaydrv.com

Paste this into an Embed / Custom HTML block on the site:

```html
<iframe
  src="https://jvergara054.github.io/Test/turntable-player/"
  title="Sunday Drv — Now Spinning"
  allow="autoplay; encrypted-media; clipboard-write"
  loading="lazy"
  style="width:100%; aspect-ratio: 4 / 3.6; border:0; background:transparent;">
</iframe>
```

Keep the `allow="autoplay; encrypted-media"` part. Without it, the browser won't let the turntable start the music.

## Change the playlist

Edit `CONFIG.playlist` at the top of `turntable.js`, or add `?playlist=<spotify link>` to the page URL.

## How it works

- Pressing START/STOP, clicking the record or the tonearm, or pressing the space bar plays or pauses the playlist through the [Spotify iFrame API](https://developer.spotify.com/documentation/embeds/references/iframe-api). It needs no API keys.
- Song title and artwork come from Spotify's public oEmbed endpoint.
  That endpoint doesn't return the artist name. Showing the artist would need a Spotify developer app and a small server.
- The tonearm follows the song's progress. When paused, it lifts in place. When stopped, it goes back to the rest.
- The 33/45 buttons and the pitch slider only change how fast the drawing spins.
- On screens narrower than 640px, the drawing crops to the deck and hides the dimension lines and labels.

### Spotify limitations

- Visitors who are signed in to Spotify in that browser hear full tracks. Everyone else hears 30-second previews.
- iPhones and Safari sometimes require one tap inside Spotify's own player. If a press of START doesn't start the music, a small Spotify panel slides up. Tap ▶ in it once and the panel goes away.

## Restyle

Colours and fonts are CSS variables at the top of `turntable.css`: `--blue`, `--bg`, `--wide`, `--cond`, `--mono`.
