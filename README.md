## Polyprofits Public Dashboard

Static dashboard repo ready for Netlify deployment.

### Local preview

From this folder:

```bash
python3 -m http.server 8080
```

Open:

`http://localhost:8080/`

### Repo structure

- `index.html`
- `styles.css`
- `app.js`
- `assets/polyprofits-logo-white.png`
- `reports/*.csv` (required data files)

### Netlify (later)

- Build command: *(leave blank)*
- Publish directory: `.`

Optional `netlify.toml` is included for the publish directory.
