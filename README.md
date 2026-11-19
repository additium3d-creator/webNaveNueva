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

## Dónde se guardan los datos
En **Supabase**, en el proyecto `additium-panel`, con tres tablas propias:
- `nave_versions`: cada versión con su escena completa, título, notas, autor, versión de partida e instrucciones.
- `nave_sessions`: sesiones de cambios abiertas, guardadas o descartadas.
- `nave_drafts`: los borradores de cada paso de una sesión, que permiten deshacer y recuperar la sesión.

Las tablas tienen RLS activado y ninguna política pública. Solo el servidor accede, con la clave secreta. El historial legible está en `/api/changelog`.

Sin `SUPABASE_URL`, el servidor guarda en una carpeta local (`DATA_DIR`). Úsalo solo para desarrollo.

## Despliegue en Render (gratis)
1. Sube esta carpeta a un repositorio de GitHub.
2. En Render, crea un **New Web Service**, conéctalo al repositorio y rellena:
   - **Runtime:** Node.
   - **Build:** `npm install`
   - **Start:** `node server.js`
   - **Instance Type:** **Free**
3. En **Environment Variables**:
   - `ANTHROPIC_API_KEY`: tu clave de la API de Anthropic.
   - `ANTHROPIC_MODEL`: viene puesto `claude-sonnet-5-5`; comprueba el identificador exacto en la documentación de modelos de Anthropic y cámbialo si hace falta.
   - `ACCESS_CODE`: el código que compartes con quien vaya a probar.
   - `ADMIN_CODE`: tu código de administrador (distinto y privado). Entrando con él ves la pestaña «Pruebas del equipo»: todas las sesiones de todo el mundo, paso a paso, aunque las hayan descartado, y puedes rescatar cualquiera como versión nueva.
   - `SUPABASE_URL`: `https://bxndeeoxvkqikmfcmook.supabase.co`
   - `SUPABASE_SERVICE_ROLE_KEY`: en Supabase, ve a Project Settings → API Keys y copia la clave **secret** (o la `service_role` en las claves antiguas). No la publiques nunca.
4. En Advanced, pon **Health Check Path** = `/api/config`, y despliega.
5. La primera vez, el servidor crea la v1 en Supabase con la nave actual.

En el plan Free, el servicio se duerme tras 15 minutos sin uso y la primera visita tarda alrededor de un minuto. No se pierde nada, porque todo está en Supabase.

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


## Novedades 1.4.0

- **Vistas generales · fotografía** (pestaña en la cabecera, aparte del visor 3D): 10 vistas generales de la nave, descarga individual y en ZIP, y «Vista nueva» para fotografiar cualquier encuadre. Las fotos se guardan en la tabla `nave_photos` de Supabase (migración ya aplicada) y quedan ligadas a la versión de la nave que se fotografió.
- **Medir** en el visor 3D: clic en dos puntos y da la distancia (total, largo, ancho y alto).
- Rótulo de la fachada con más contraste.
