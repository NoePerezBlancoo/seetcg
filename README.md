# SeeTCG

**SeeTCG** es una PWA móvil para escanear, identificar y valorar cartas TCG.

## MVP actual

La primera versión está centrada en Pokémon TCG y no necesita backend ni claves API:

- cámara/imagen desde móvil;
- OCR local con Tesseract.js;
- extracción de nombre y número de colección;
- ranking de candidatos y confirmación manual;
- búsqueda por nombre/número;
- catálogo ES/EN;
- precios de Cardmarket y TCGplayer obtenidos mediante TCGdex;
- conversión USD→EUR con Frankfurter;
- estimación robusta mediante mediana de referencias comparables;
- variantes normal, reverse, holo y 1ª edición cuando existen;
- colección persistida en el navegador;
- PWA instalable;
- CI en GitHub Actions.

## Arquitectura

```text
Cámara / imagen
      ↓
Tesseract.js OCR
      ↓
número + tokens de nombre
      ↓
TCGdex ──────────────┐
  │                  │
Cardmarket EUR   TCGplayer USD
  │                  │
  │             Frankfurter FX
  └─────────┬────────┘
            ↓
  estimación en EUR
            ↓
  colección local
```

## Desarrollo

No hay build obligatorio. Sirve el repositorio mediante cualquier servidor estático HTTPS.

Para validar JavaScript:

```bash
npm run check
```

La cámara del navegador requiere HTTPS (o localhost).

## Precio de mercado

SeeTCG evita una media aritmética simple. Combina referencias disponibles y utiliza la mediana entre fuentes comparables. Los mínimos/máximos son orientativos.

El estado, idioma, edición, grading, errores de impresión y liquidez pueden alterar mucho el precio real. SeeTCG muestra una referencia de mercado, no una tasación profesional.

## Datos y privacidad

- Las fotos no se suben a un backend propio.
- El OCR se ejecuta en el navegador.
- La colección se guarda en `localStorage`.
- TCGdex aporta catálogo y pricing agregado.
- Frankfurter aporta el cambio USD/EUR.
- Tesseract.js se carga desde CDN en este MVP.

Antes de un lanzamiento comercial deben revisarse las condiciones de cada fuente/marketplace.

## Siguiente fase

La capa de interfaz ya está preparada para crecer hacia backend propio, cuentas sincronizadas, histórico de precios, eBay/CardTrader/JustTCG, Magic, Yu-Gi-Oh!, One Piece, Lorcana, reconocimiento visual por embeddings, grading asistido y alertas.

## Licencia

MIT.
