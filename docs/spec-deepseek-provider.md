# Spec: DeepSeek como proveedor de LLM

Estado: `ready-for-agent`

## Problem Statement

El agente de triage solo puede correr contra Claude a través de la API de Anthropic. Esa API se factura aparte de los planes de consumidor (Pro), así que quien desarrolla el proyecto sin créditos en Console no puede ejecutar `triage` ni `npm run eval` contra un modelo real. Hoy solo puede verificar el comportamiento con `FakeClient` o con el script de smoke, que trae su propio cliente de DeepSeek fuera del código entregado y no ejercita el pipeline completo (repair, corpus de duplicados, `meta`).

La SPEC v1 deja explícitamente fuera de alcance a cualquier proveedor que no sea Claude (§9) y exige que la única llamada de red de `src/` sea la de Anthropic (§10, paso 6). Habilitar DeepSeek requiere cambiar la spec, no solo el código.

## Solution

DeepSeek pasa a ser un proveedor soportado detrás del `LLMClient` existente. Quien usa el CLI elige el proveedor con `--provider claude|deepseek` o con la variable `TRIAGE_PROVIDER`. Por defecto sigue siendo `claude`, así que nada cambia para quien no lo pida. Con `deepseek`, el CLI y el golden eval usan la key `DEEPSEEK_API_KEY` y el modelo por defecto de DeepSeek. El pipeline de triage (prefiltro de duplicados, prompt, validación con zod, validador de calidad, un único repair) es el mismo para ambos proveedores, y el `TriageResult` tiene la misma forma.

Como DeepSeek no fuerza la salida a un JSON Schema (solo garantiza JSON válido), la conformidad con `LlmTriageOutput` deja de estar garantizada por el proveedor y pasa a depender del parseo con zod y del repair loop que ya existen.

## User Stories

1. Como desarrollador sin créditos en la API de Anthropic, quiero correr `triage` contra DeepSeek, para probar el agente con un modelo real usando créditos que ya tengo.
2. Como desarrollador, quiero elegir el proveedor con `--provider deepseek`, para cambiarlo en una sola invocación sin tocar el entorno.
3. Como desarrollador, quiero fijar el proveedor con `TRIAGE_PROVIDER`, para no repetir el flag en cada invocación.
4. Como desarrollador, quiero que `--provider` tenga prioridad sobre `TRIAGE_PROVIDER`, para poder sobrescribir el entorno puntualmente, igual que `--model` sobre `TRIAGE_MODEL`.
5. Como usuario actual del CLI, quiero que el proveedor por defecto siga siendo `claude`, para que mis scripts y mi CI no cambien de comportamiento.
6. Como desarrollador, quiero que un proveedor desconocido salga con código `2` y el uso del CLI, para enterarme del typo antes de cualquier llamada de red.
7. Como desarrollador, quiero que con `deepseek` el CLI lea `DEEPSEEK_API_KEY`, para no mezclar credenciales de proveedores distintos.
8. Como desarrollador, quiero que si falta la key del proveedor elegido el error nombre esa variable, para saber exactamente qué configurar.
9. Como desarrollador, quiero que un ticket inválido salga con código `2` sin construir el cliente ni llamar a ningún proveedor, para que la validación de entrada siga siendo independiente del LLM (AC-2).
10. Como desarrollador, quiero que cada proveedor tenga su modelo por defecto (`claude-sonnet-5-5` y `deepseek-flash`), para no tener que pasar `--model` siempre.
11. Como desarrollador, quiero que `--model` y `TRIAGE_MODEL` se apliquen al proveedor elegido, para poder usar `deepseek-v4-pro` cuando haga falta.
12. Como revisor de un triage, quiero que `meta.model` muestre el modelo real que respondió, para saber qué proveedor produjo cada resultado.
13. Como revisor, quiero que el `TriageResult` tenga la misma forma con cualquier proveedor, para que mis herramientas de revisión no distingan casos.
14. Como responsable de calidad, quiero que una salida de DeepSeek que no cumpla `LlmTriageOutput` pase por el repair existente con los problemas de zod, para que la falta de schema forzado no rompa el pipeline.
15. Como responsable de calidad, quiero que una salida irreparable salga con código `3` (`TriageOutputError`), igual que con Claude.
16. Como desarrollador, quiero que los errores de red, 429 y 5xx de DeepSeek se reintenten hasta `maxRetries`, para tener la misma resiliencia que da el SDK de Anthropic.
17. Como desarrollador, quiero que los errores 4xx distintos de 429 (key inválida, pedido mal formado) no se reintenten y salgan con código `3`, para no gastar llamadas inútiles.
18. Como desarrollador, quiero que la respuesta vacía en modo JSON (un problema documentado de DeepSeek) se trate como error reintentable, para que un caso esporádico no tumbe el triage.
19. Como desarrollador, quiero que una salida cortada por `max_tokens` sea un `LLMError` no reintentable, igual que con Claude.
20. Como desarrollador, quiero que un timeout de DeepSeek respete `timeoutMs`, para que una llamada colgada no bloquee el CLI.
21. Como responsable de seguridad, quiero que con DeepSeek el texto del ticket siga yendo dentro de `<ticket>` y que `raw` nunca se envíe, para que las reglas de input no confiable (§4.6) valgan para todos los proveedores.
22. Como responsable de seguridad, quiero que la key de DeepSeek nunca aparezca en mensajes de error ni en la salida, para no filtrarla en logs.
23. Como responsable de evals, quiero correr `npm run eval` con `TRIAGE_PROVIDER=deepseek`, para medir el golden set contra DeepSeek.
24. Como responsable de evals, quiero que el scorecard del eval muestre el proveedor y el modelo, para comparar corridas de proveedores distintos.
25. Como responsable de evals, quiero que el eval falle temprano si falta la key del proveedor elegido, como hoy pasa con `ANTHROPIC_API_KEY`.
26. Como mantenedor, quiero que `npm test` siga sin red y sin keys de ningún proveedor, para que CI no dependa de credenciales.
27. Como mantenedor, quiero no sumar dependencias de runtime para DeepSeek, para mantener la superficie de dependencias de §6.5.
28. Como consumidor de la librería, quiero que `DeepSeekClient` se exporte desde la API pública junto a `ClaudeClient`, para usarlo con `triageTicket` sin pasar por el CLI.
29. Como consumidor de la librería, quiero que `DeepSeekClient` acepte las mismas opciones que `ClaudeClient` (`apiKey`, `model`, `timeoutMs`, `maxRetries`, `fetch`), para intercambiarlos sin sorpresas.
30. Como desarrollador, quiero que el script de smoke use el `DeepSeekClient` de la librería, para que haya un solo cliente de DeepSeek en el repo.
31. Como lector de la SPEC, quiero que §6, §9, §10 y §11 reflejen el segundo proveedor, para que la spec siga siendo la fuente de verdad.

## Implementation Decisions

- **Seam del proveedor: `LLMClient` sin cambios.** `DeepSeekClient` implementa `generateStructured(StructuredRequest) → StructuredResponse` y lanza `LLMError` con `retryable`. `triageTicket`, `buildTriagePrompt`, `buildRepairPrompt`, `validateResult` y `FakeClient` no cambian.
- **Módulo nuevo `DeepSeekClient` en la capa `llm`**, al lado de `ClaudeClient`, con opciones `{ apiKey?, model?, timeoutMs = 60_000, maxRetries = 2, fetch? }`. Lee `DEEPSEEK_API_KEY`. Si falta la key, falla en el primer pedido y no al construirse, igual que `ClaudeClient`. Se exporta desde la API pública.
- **Transporte:** la API de Chat Completions de DeepSeek, compatible con OpenAI (`https://api.deepseek.com`), con `fetch` nativo. No se suma ninguna dependencia de runtime. El `fetch` inyectable es la costura de test, como en `ClaudeClient`.
- **Salida estructurada:** `response_format: { type: "json_object" }`. DeepSeek no soporta `json_schema`. El cliente agrega al system prompt el JSON Schema de `req.jsonSchema` y la instrucción de responder con un único objeto JSON (DeepSeek exige la palabra "json" en el prompt). Es responsabilidad del cliente y no del constructor del prompt, para que `buildTriagePrompt` siga siendo neutral respecto del proveedor y el prompt de Claude no cambie.
- **Mapeo de la respuesta:** `choices[0].message.content` se parsea como JSON y va a `output`. `model` sale del campo de la respuesta, y `usage` de `prompt_tokens` / `completion_tokens`.
- **Errores:**
  - red y timeout → retryable;
  - HTTP 429 y 5xx → retryable;
  - otros 4xx → no retryable;
  - `finish_reason: "length"` → no retryable (truncado);
  - `finish_reason: "content_filter"` → no retryable (equivale a un refusal);
  - contenido vacío → retryable;
  - JSON inválido → no retryable.

  Los mensajes no incluyen la key.
- **Reintentos:** a diferencia del SDK de Anthropic, `fetch` no reintenta solo. El cliente reintenta los errores retryable hasta `maxRetries` veces con backoff exponencial corto, y respeta `retry-after` si viene.
- **Selección de proveedor en el CLI:** nuevo flag `--provider <claude|deepseek>` y variable `TRIAGE_PROVIDER`. Precedencia: flag > variable > `claude`. Un valor desconocido es un error de uso (código `2`). La validación del proveedor ocurre junto con la de los argumentos, antes de leer el ticket.
- **Resolución de modelo por proveedor:** `--model` > `TRIAGE_MODEL` > modelo por defecto del proveedor (`claude-sonnet-5-5` / `deepseek-flash`). No se valida que el modelo pertenezca al proveedor: un modelo incorrecto falla en la API y sale con código `3`.
- **Fábrica de clientes del CLI:** la costura de test existente (`CliClientFactory`) pasa a recibir `{ provider, model, apiKey }`. La key es la del proveedor elegido. El CLI sigue sin construir el cliente si la entrada es inválida.
- **Golden eval:** el runner elige el proveedor con `TRIAGE_PROVIDER`, exige la key de ese proveedor y muestra proveedor y modelo en el encabezado del scorecard. Los umbrales de los casos no cambian.
- **Sin cambios de schema:** `TriageResult` y `meta` no ganan un campo `provider`. `meta.model` ya identifica al proveedor.
- **Script de smoke:** deja de tener su propio cliente de DeepSeek y usa el de la librería. Sigue fuera de `src/`.
- **Cambios en SPEC.md:**
  - §6.1: documentar `DeepSeekClient` y que no garantiza el schema.
  - §6.4: agregar `--provider` y `TRIAGE_PROVIDER`.
  - §6.5: aclarar que DeepSeek no agrega dependencias.
  - §7: el eval acepta `TRIAGE_PROVIDER`.
  - §9: quitar DeepSeek de "fuera de alcance". Otros proveedores siguen fuera.
  - §10, paso 6: las llamadas de red salientes de `src/` son el Messages API de Anthropic y el Chat Completions de DeepSeek, cada una en su cliente.
  - §11: AC nuevo para el proveedor.

## Testing Decisions

- **Qué es un buen test acá:** se testea comportamiento externo en las dos costuras acordadas, no detalles internos. Para el cliente: qué pedido HTTP sale y qué `StructuredResponse` o `LLMError` vuelve, observado con un `fetch` falso. Para el CLI: códigos de salida, stdout/stderr y la configuración que recibe la fábrica. Ningún test toca la red ni requiere keys reales (AC-1).
- **`DeepSeekClient`** (prior art: los tests de `ClaudeClient`, que inyectan `fetch` y graban URL, headers y body):
  - el pedido va a Chat Completions con `Authorization: Bearer`, el modelo resuelto, `max_tokens`, `response_format: json_object`, y los mensajes del usuario sin modificar;
  - el system prompt contiene el system del pedido, la palabra "json" y el JSON Schema;
  - un `content` JSON válido se devuelve como `output`, con `model` y `usage` mapeados;
  - 401/400 → `LLMError` no retryable, sin reintento;
  - 429/5xx y error de red → reintenta hasta `maxRetries` y después lanza `LLMError` retryable;
  - un 429 seguido de éxito devuelve el éxito;
  - contenido vacío → retryable;
  - `finish_reason: "length"` y JSON inválido → no retryable;
  - sin key → `LLMError` en el primer pedido y ninguna llamada a `fetch`;
  - la key no aparece en ningún mensaje de error.
- **CLI** (prior art: el bloque "model selection" de los tests del CLI, que usa la fábrica):
  - por defecto la fábrica recibe `provider: "claude"`;
  - `TRIAGE_PROVIDER=deepseek` y `--provider deepseek` seleccionan DeepSeek, y el flag gana sobre la variable;
  - con DeepSeek la fábrica recibe `DEEPSEEK_API_KEY` y el modelo por defecto `deepseek-flash`, salvo `--model` / `TRIAGE_MODEL`;
  - un proveedor desconocido sale con `2` sin construir el cliente;
  - un ticket inválido con `--provider deepseek` sale con `2` sin construir el cliente;
  - un `TriageResultSchema` válido producido con un `FakeClient` sigue saliendo por stdout.
- **Pipeline:** no hacen falta tests nuevos de `triageTicket`. El repair por `SCHEMA_INVALID` ya está cubierto y es el camino que ejercita DeepSeek cuando no cumple el schema.
- **Verificación manual (no CI):** `npm run eval` con `TRIAGE_PROVIDER=deepseek`, y el script de smoke contra `fixtures/tickets/bug-clear.json`.

## Out of Scope

- Otros proveedores (OpenAI, Gemini, modelos locales). El seam lo permitiría, pero esta spec solo habilita DeepSeek.
- Fallback automático entre proveedores o ruteo por costo/latencia.
- Cambiar el proveedor por defecto: sigue siendo `claude`.
- Usar el endpoint compatible con Anthropic que ofrece DeepSeek.
- Ajustar el prompt de producción por proveedor, más allá de inyectar el schema en el system prompt.
- Visión, tool calls o el razonamiento expuesto (`reasoning_content`) de DeepSeek.
- Calcular costo dentro del `TriageResult` o una tabla de precios en `src/`. El costo se sigue midiendo fuera, según `docs/success-criteria.md`.
- Recalibrar los umbrales de los success criteria o del golden eval por proveedor.

## Further Notes

- La garantía de schema es la diferencia de fondo. Con Claude, `output_config.format` restringe la salida al JSON Schema. Con DeepSeek, el schema es una instrucción del prompt y zod es la única barrera. Hay que esperar más repairs por `SCHEMA_INVALID` y, por lo tanto, más costo y latencia por ticket en los casos difíciles. Conviene medirlo en el golden eval antes de sacar conclusiones de calidad.
- En la prueba de smoke con el prompt de producción, `deepseek-flash` devolvió para `bug-clear.json` una salida que cumple el schema, sin warnings de calidad, por unos USD 0,004 y en unos 11 s. Es un solo caso y no reemplaza al eval.
- Los precios de DeepSeek dependen del horario (fuera de pico cuestan la mitad) y del cache. Eso afecta cómo se miden SC-1/SC-2 si el eval corre con DeepSeek.
- DeepSeek documenta que el modo JSON puede devolver contenido vacío ocasionalmente. De ahí la decisión de tratarlo como retryable.
- La ruta alternativa por el endpoint compatible con Anthropic reutilizaría `ClaudeClient` con otra `baseURL`, pero depende de que DeepSeek acepte `output_config.format` con `json_schema`, algo que su documentación no confirma. Se descartó para esta spec.
