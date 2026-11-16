# Nave Da Vinci 16 · visor 3D con asistente de cambios

Web de Additium3D para recorrer en 3D la nueva sede (Calle Leonardo Da Vinci 16, Parque Tecnológico de Paterna) y pedir cambios en lenguaje natural. Un asistente de Claude edita la escena, el visor se recarga manteniendo tu posición y, al terminar, la sesión se guarda **siempre como una versión nueva**. Nunca se sobrescribe ninguna versión.

## Cómo funciona
- **Visor:** la escena Three.js a escala real, con las tres plantas y colisiones. Se puede recorrer a pie.
- **Panel de comunicación (abajo):**
  - Escribes el cambio y el asistente busca en el código, edita, comprueba la sintaxis y te resume qué ha hecho.
  - Ves cada paso en directo.
  - **Deshacer** quita el último cambio de la sesión y **Descartar** cierra la sesión sin guardar.
  - **Guardar versión** crea la versión siguiente, con título, notas, autor, versión de partida e instrucciones aplicadas.
  - Al cabo de 8 minutos sin actividad, la web te pregunta si quieres guardar. También avisa si cierras la pestaña con cambios sin guardar.
- **Historial:**
  - Muestra todas las versiones, quién las hizo, de cuál parten y qué se pidió.
  - Para cada versión puedes ver el diff de código respecto a la anterior.
  - Con «Editar desde aquí» puedes partir de cualquier versión antigua: se crea una rama y la trazabilidad queda reflejada.
- **Errores:** si el visor falla al cargar un borrador, se pide el arreglo al asistente automáticamente, una sola vez.

Los datos se guardan en `DATA_DIR`:
- `versions/vN.html`: una escena completa por versión.
- `versions/index.json`: los metadatos.
- `versions/CHANGELOG.md`: un registro legible de los cambios.
- `sessions/`: los borradores y el historial de cada sesión.

## Despliegue en Render
1. Sube esta carpeta a un repositorio de GitHub.
2. En Render, ve a **New → Blueprint** y elige el repositorio. Render lee `render.yaml`: crea un servicio web con Node y un **disco persistente de 1 GB** en `/var/data`.
   - El disco solo está disponible en planes de pago (Starter o superior).
   - Sin disco, las versiones se pierden en cada redeploy.
3. Rellena las variables:
   - `ANTHROPIC_API_KEY`: tu clave de la API de Anthropic.
   - `ANTHROPIC_MODEL`: identificador del modelo. Viene puesto `claude-sonnet-5-5`; comprueba el identificador exacto en la documentación de modelos de Anthropic y cámbialo aquí si hace falta.
   - `ACCESS_CODE`: el código que compartes con quien vaya a probar. Sin código, cualquiera con el enlace puede gastar tu API.
4. Abre la URL de Render, escribe tu nombre y el código.

## En local
```bash
npm install
npm run dev                   # modo demostración, sin API: añade un bloque de prueba en cada cambio
ANTHROPIC_API_KEY=sk-... ACCESS_CODE=prueba npm start
```
Abre http://localhost:3000

## Variables opcionales
- `AGENT_MAX_STEPS` (30): pasos máximos del agente por mensaje.
- `MOCK_AGENT=1`: fuerza el modo demostración.

## Coste y límites
- Cada mensaje es una pequeña sesión del agente con herramientas: busca, lee fragmentos y edita. La guía fija va en caché de prompt, así que el coste por cambio es moderado.
- Hay un límite de 60 mensajes por hora y por IP.
- Cada sesión procesa un cambio a la vez. Varias personas pueden editar en paralelo, cada una en su sesión.
