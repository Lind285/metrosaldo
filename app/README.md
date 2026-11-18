# MetroSaldo – App móvil (React Native + Expo)

Monedero virtual de seguimiento del saldo de la tarjeta del Metropolitano. El saldo es una **estimación** basada en lo que registra el usuario; la app no se conecta con el sistema oficial.

## Funcionalidades implementadas

| Historia | Funcionalidad |
|---|---|
| HU1 | Configuración inicial: nombre, tipo de tarifa y saldo inicial |
| HU2 | Registrar viaje (troncal o integrada), registrar recarga y corregir saldo |
| HU3 | Historial con filtros (todo, viajes y recargas; esta semana, este mes y todo) y totales del periodo |
| HU4 | Alerta de saldo bajo con umbral configurable, que se puede activar o desactivar |
| HU5 | Predicción de la fecha de agotamiento con regresión lineal, con nivel de confianza |
| HU8 | Sugerencia de recarga para los próximos 7 días |
| — | Estadísticas: gasto de los últimos 7 días |
| — | Datos de demostración (simulados) |

Los datos se guardan solo en el celular, con AsyncStorage.

## Tarifas usadas (2026)

| Tarifa | Troncal | Integrada (alimentador + troncal) |
|---|---|---|
| Medio pasaje | S/ 1.60 | S/ 1.75 |
| General | S/ 3.20 | S/ 3.50 |

## Modelo

La app usa los coeficientes de la regresión lineal entrenada en Python. Están en `modelo_regresion_lineal.json`, en la carpeta `ml/`.

Las reglas según los días de historial son:

| Días de historial | Método | Confianza |
|---|---|---|
| Menos de 7 | Promedio diario | Baja |
| De 7 a 13 | Regresión lineal | Media |
| 14 o más | Regresión lineal | Alta |

El archivo `prueba_modelo_js_vs_python.txt` muestra que, en 5 casos del dataset, la app calcula exactamente la misma fecha y el mismo gasto de 7 días que el modelo en Python.

## Cómo ejecutarla (sin instalar nada en la computadora)

1. Instala **Expo Go** desde Play Store en tu celular Android.
2. Entra a https://snack.expo.dev desde la computadora.
3. Borra el contenido de `App.js` y pega el contenido de este `App.js`.
4. Si aparece el aviso para agregar la dependencia `@react-native-async-storage/async-storage`, haz clic en **Add dependency**.
5. En el panel derecho elige **My Device**. Luego abre Expo Go en el celular y escanea el código QR.
6. Haz clic en **Save** para obtener un enlace del proyecto, que sirve como evidencia.

> Prueba la app en el celular, no en la vista previa web: las alertas (`Alert`) no se muestran en la versión web.
