# OneDrive Authentifizierung - Electron App

Diese Electron App löst das Problem der OneDrive Authentifizierung mit `onedrive abraunegg` durch eine benutzerfreundliche GUI.


## Lösung

Diese Electron App bietet:
- **Automatische Browser-Öffnung**: Das Auth-Fenster öffnet sich automatisch
- **URL-Weiterleitung**: Automatische Erkennung und Weiterleitung der Auth-URL
- **Benutzerfreundliche GUI**: Einfache Bedienung ohne manuelle URL-Eingabe

## Verwendung

1. **App starten**:
   ```bash
   npm run dev
   ```

2. **OneDrive Authentifizierung**:
   - Klicken Sie auf "OneDrive Authentifizierung starten"
   - Ein Browser-Fenster öffnet sich automatisch
   - Melden Sie sich bei Microsoft an
   - Die App erkennt automatisch die Weiterleitung und schließt das Fenster

3. **Status überwachen**:
   - Alle Schritte werden in der Status-Historie angezeigt
   - Klicken Sie auf das Info-Icon für detaillierte Meldungen

## Technische Details

### Architektur

```
Electron Main Process (index.js)
├── OneDrive Auth Process (spawn)
├── Auth Window (BrowserWindow)
└── URL Handling (will-navigate)
```

### Workflow

1. **Auth-Prozess starten**: `onedrive --auth-files request:response`
2. **URL abwarten**: Überwachung der `request.url` Datei
3. **Browser öffnen**: Automatisches Laden der Auth-URL
4. **Redirect erkennen**: Automatische Erkennung der Response-URL
5. **Response speichern**: Automatisches Schreiben in `response.url`

### Dateien

- `index.js`: Hauptprozess mit OneDrive Integration
- `index.html`: Benutzeroberfläche
- `preload.js`: IPC Bridge

## Konfiguration

Die App verwendet die Standard OneDrive Konfiguration:
- Config-Verzeichnis: `~/.config/onedrive`
- Auth-Dateien: `~/.config/onedrive/auth/request.url` und `response.url`

## Voraussetzungen

- `onedrive` (abraunegg) muss installiert sein
- Node.js und npm
- Electron

## Build

```bash
npm run build
```

Erstellt eine AppImage für Linux.