import React, { useEffect, useMemo, useState } from 'react';
import {
  Alert,
  Pressable,
  ScrollView,
  StatusBar,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  View,
} from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';

const CLAVE_DATOS = 'metrosaldo_v1';
const ROJO = '#C8102E';
const OSCURO = '#1F2328';

// Tarifas 2026 del Metropolitano (S/)
const TARIFAS = {
  universitaria: { troncal: 1.6, integrada: 1.75 },
  general: { troncal: 3.2, integrada: 3.5 },
};

// === INICIO MODELO ===
// Coeficientes de la regresión lineal entrenada en Python (scikit-learn) con el
// dataset sintético (archivo modelo_regresion_lineal.json del repositorio).
const MODELO = {
  intercepto: -0.4167617092359688,
  coef: {
    dia_mar: -0.025779074038820224,
    dia_mie: 0.10984767715898992,
    dia_jue: 0.1060747036855248,
    dia_vie: -0.029240387414313715,
    dia_sab: 0.13278951521727722,
    dia_dom: -0.46655408009659277,
    es_feriado: -1.7578328233122458,
    tarifa_troncal: 0.5294398390017011,
    prom_gasto_7d: -0.14936194591512159,
    prom_mismo_dia_4sem: 0.7448879044867548,
    dias_con_viaje_7d: 0.1044668021706564,
  },
};
const NOMBRES_DIA = ['lun', 'mar', 'mie', 'jue', 'vie', 'sab', 'dom'];

// Feriados nacionales considerados
const FERIADOS = ['2026-08-30', '2026-10-08', '2026-11-01', '2026-12-08', '2026-12-09', '2026-12-25', '2027-01-01'];

const pad = (n) => String(n).padStart(2, '0');
const claveFecha = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const diaSemana = (d) => (d.getDay() + 6) % 7; // 0 = lunes ... 6 = domingo (igual que en Python)
const sumarDias = (d, k) => {
  const x = new Date(d);
  x.setDate(x.getDate() + k);
  return x;
};
const inicioDelDia = (d) => {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
};
const promedio = (arr) => (arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0);

function calcularSaldo(movimientos) {
  return movimientos.reduce((s, m) => s + (m.tipo === 'viaje' ? -m.monto : m.monto), 0);
}

function gastoPorDia(movimientos) {
  const g = {};
  movimientos.forEach((m) => {
    if (m.tipo === 'viaje') {
      const k = claveFecha(new Date(m.fecha));
      g[k] = (g[k] || 0) + m.monto;
    }
  });
  return g;
}

// Días completos de historial 
function historialDias(movimientos, hoy) {
  if (!movimientos.length) return [];
  const gastos = gastoPorDia(movimientos);
  const primero = inicioDelDia(new Date(Math.min(...movimientos.map((m) => new Date(m.fecha).getTime()))));
  const dias = [];
  for (let d = primero; d < hoy; d = sumarDias(d, 1)) {
    dias.push({ fecha: claveFecha(d), dow: diaSemana(d), gasto: gastos[claveFecha(d)] || 0 });
  }
  return dias;
}

function predecirGastoDia(x) {
  let y = MODELO.intercepto;
  Object.keys(MODELO.coef).forEach((k) => {
    y += MODELO.coef[k] * (x[k] || 0);
  });
  return Math.max(0, y);
}

function variablesDia(fecha, tarifaTroncal, p7, v7, mismoDia) {
  const dow = diaSemana(fecha);
  const x = {
    es_feriado: FERIADOS.includes(claveFecha(fecha)) ? 1 : 0,
    tarifa_troncal: tarifaTroncal,
    prom_gasto_7d: p7,
    prom_mismo_dia_4sem: mismoDia,
    dias_con_viaje_7d: v7,
  };
  for (let j = 1; j < 7; j++) x[`dia_${NOMBRES_DIA[j]}`] = dow === j ? 1 : 0;
  return x;
}

/**
 * Proyecta el saldo día a día y devuelve la fecha en que dejará de cubrir un pasaje.
 * - Menos de 7 días de historial: promedio diario (confianza baja).
 * - Desde 7 días: regresión lineal (confianza media); desde 14 días: confianza alta.
 */
function calcularPrediccion(movimientos, perfil, ahora = new Date()) {
  const hoy = inicioDelDia(ahora);
  const tarifa = TARIFAS[perfil.tipoTarifa].troncal;
  const saldo = calcularSaldo(movimientos);
  const viajes = movimientos.filter((m) => m.tipo === 'viaje');
  if (!viajes.length) {
    return { disponible: false, mensaje: 'Registra tus viajes para ver cuándo se acabaría tu saldo.' };
  }
  if (saldo < tarifa) {
    return { disponible: true, agotado: true, mensaje: 'Tu saldo estimado ya no cubre un pasaje troncal.' };
  }
  const hist = historialDias(movimientos, hoy);
  const gastoHoy = gastoPorDia(movimientos)[claveFecha(hoy)] || 0;
  const n = hist.length;
  let metodo;
  let confianza;
  let gastoDe;

  if (n < 7) {
    metodo = 'promedio';
    confianza = 'baja';
    const prom = (hist.reduce((a, d) => a + d.gasto, 0) + gastoHoy) / (n + 1);
    gastoDe = () => prom;
  } else {
    metodo = 'regresion';
    confianza = n >= 14 ? 'alta' : 'media';
    const ult7 = hist.slice(-7);
    const p7 = promedio(ult7.map((d) => d.gasto));
    const v7 = ult7.filter((d) => d.gasto > 0).length;
    const mismo = {};
    for (let j = 0; j < 7; j++) {
      const ult4 = hist.filter((d) => d.dow === j).slice(-4);
      mismo[j] = ult4.length ? promedio(ult4.map((d) => d.gasto)) : p7;
    }
    gastoDe = (fecha) => predecirGastoDia(variablesDia(fecha, tarifa, p7, v7, mismo[diaSemana(fecha)]));
  }

  let saldoProy = saldo;
  let fechaAgota = null;
  let gasto7 = 0;
  for (let k = 0; k < 60; k++) {
    const fecha = sumarDias(hoy, k);
    let g = gastoDe(fecha);
    if (k === 0) g = Math.max(0, g - gastoHoy); // lo ya gastado hoy está descontado del saldo
    if (k < 7) gasto7 += g;
    saldoProy -= g;
    if (fechaAgota === null && saldoProy < tarifa) {
      fechaAgota = fecha;
      if (k >= 6) break;
    }
  }
  return { disponible: true, agotado: false, fecha: fechaAgota, metodo, confianza, diasHistorial: n, gasto7, saldo };
}
// === FIN MODELO ===

// ---------------------------------------------------------------- Utilidades de formato
const DIAS_TXT = ['dom', 'lun', 'mar', 'mié', 'jue', 'vie', 'sáb'];
const MESES_TXT = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'set', 'oct', 'nov', 'dic'];
const soles = (n) => `S/ ${n < 0 ? '-' : ''}${Math.abs(n).toFixed(2)}`;
const fechaCorta = (d) => `${DIAS_TXT[d.getDay()]} ${d.getDate()} ${MESES_TXT[d.getMonth()]}`;
const hora = (d) => `${pad(d.getHours())}:${pad(d.getMinutes())}`;
const nuevoId = () => `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

function generarDemo(tipoTarifa) {
  // Datos SIMULADOS para demostración: 21 días de uso con un patrón de estudiante
  let semilla = 7;
  const azar = () => {
    semilla = (semilla * 9301 + 49297) % 233280;
    return semilla / 233280;
  };
  const t = TARIFAS[tipoTarifa];
  const hoy = inicioDelDia(new Date());
  const movs = [];
  let saldo = 20;
  const agregar = (m) => {
    movs.push({ id: nuevoId(), ...m });
  };
  const inicio = sumarDias(hoy, -21);
  agregar({ tipo: 'inicial', monto: 20, fecha: new Date(inicio.getTime() + 7 * 3600e3).toISOString() });
  for (let k = 0; k < 21; k++) {
    const d = sumarDias(inicio, k);
    const dow = diaSemana(d);
    const p = dow <= 4 ? 0.9 : dow === 5 ? 0.3 : 0.05;
    if (azar() < p) {
      if (saldo < 2 * t.troncal + 1) {
        agregar({ tipo: 'recarga', monto: 20, fecha: new Date(d.getTime() + 7 * 3600e3).toISOString() });
        saldo += 20;
      }
      [7.5, 18.5].forEach((h) => {
        agregar({ tipo: 'viaje', subtipo: 'troncal', monto: t.troncal, fecha: new Date(d.getTime() + h * 3600e3).toISOString() });
        saldo -= t.troncal;
      });
    }
  }
  return movs;
}

// ---------------------------------------------------------------- Componentes pequeños
function Boton({ titulo, onPress, tipo = 'primario', estilo }) {
  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => [
        styles.boton,
        tipo === 'primario' ? styles.botonPrimario : styles.botonSecundario,
        pressed && { opacity: 0.7 },
        estilo,
      ]}
    >
      <Text style={tipo === 'primario' ? styles.botonTextoPrimario : styles.botonTextoSecundario}>{titulo}</Text>
    </Pressable>
  );
}

function Chip({ texto, activo, onPress }) {
  return (
    <Pressable onPress={onPress} style={[styles.chip, activo && styles.chipActivo]}>
      <Text style={[styles.chipTexto, activo && styles.chipTextoActivo]}>{texto}</Text>
    </Pressable>
  );
}

function Encabezado({ titulo, onVolver }) {
  return (
    <View style={styles.encabezado}>
      {onVolver ? (
        <Pressable onPress={onVolver} style={styles.volver}>
          <Text style={styles.volverTexto}>‹</Text>
        </Pressable>
      ) : null}
      <Text style={styles.titulo}>{titulo}</Text>
    </View>
  );
}

function Fila({ etiqueta, valor, negrita }) {
  return (
    <View style={styles.fila}>
      <Text style={styles.filaEtiqueta}>{etiqueta}</Text>
      <Text style={[styles.filaValor, negrita && { fontWeight: '700', fontSize: 16 }]}>{valor}</Text>
    </View>
  );
}

// ---------------------------------------------------------------- Pantallas
function Bienvenida({ onGuardar }) {
  const [nombre, setNombre] = useState('');
  const [tipoTarifa, setTipoTarifa] = useState('universitaria');
  const [saldoTxt, setSaldoTxt] = useState('');

  const guardar = () => {
    const saldo = parseFloat(saldoTxt.replace(',', '.'));
    if (!nombre.trim()) return Alert.alert('Falta tu nombre', 'Escribe tu nombre para continuar.');
    if (isNaN(saldo) || saldo < 0) return Alert.alert('Saldo no válido', 'Ingresa un saldo mayor o igual a 0.');
    onGuardar({ nombre: nombre.trim(), tipoTarifa, saldo });
  };

  return (
    <ScrollView contentContainerStyle={styles.contenido} keyboardShouldPersistTaps="handled">
      <Text style={styles.logo}>▣ MetroSaldo</Text>
      <Text style={styles.tituloGrande}>Sabe cuánto te queda antes de llegar al torniquete</Text>
      <Text style={styles.texto}>Registra tus viajes y recargas en pocos toques y planifica cuándo recargar.</Text>
      <View style={styles.aviso}>
        <Text style={styles.avisoTexto}>
          MetroSaldo no se conecta al sistema oficial del Metropolitano. Tu saldo es una estimación basada en lo que registras.
        </Text>
      </View>

      <Text style={styles.etiqueta}>Tu nombre</Text>
      <TextInput style={styles.input} value={nombre} onChangeText={setNombre} placeholder="Ej.: Camila" />

      <Text style={styles.etiqueta}>Tipo de tarifa</Text>
      <View style={styles.filaChips}>
        <Chip texto="Medio pasaje (universitario)" activo={tipoTarifa === 'universitaria'} onPress={() => setTipoTarifa('universitaria')} />
        <Chip texto="General" activo={tipoTarifa === 'general'} onPress={() => setTipoTarifa('general')} />
      </View>

      <Text style={styles.etiqueta}>Saldo actual de tu tarjeta (míralo en un torniquete o tótem)</Text>
      <TextInput style={[styles.input, styles.inputGrande]} value={saldoTxt} onChangeText={setSaldoTxt} keyboardType="decimal-pad" placeholder="0.00" />

      <Boton titulo="Empezar" onPress={guardar} estilo={{ marginTop: 24 }} />
    </ScrollView>
  );
}

function Inicio({ perfil, movimientos, prediccion, irA }) {
  const saldo = calcularSaldo(movimientos);
  const bajo = saldo < perfil.umbral;
  const ultimo = [...movimientos].sort((a, b) => new Date(b.fecha) - new Date(a.fecha))[0];

  let textoPred = prediccion.mensaje;
  if (prediccion.disponible && !prediccion.agotado) {
    textoPred = prediccion.fecha ? `Te alcanza hasta aprox. ${fechaCorta(prediccion.fecha)}` : 'Te alcanza para más de 60 días';
  }
  const sugerido = prediccion.disponible && !prediccion.agotado ? prediccion.gasto7 - saldo : 0;

  return (
    <ScrollView contentContainerStyle={styles.contenido}>
      {perfil.demo ? (
        <View style={styles.avisoDemo}>
          <Text style={styles.avisoTexto}>Estás viendo datos de demostración (simulados).</Text>
        </View>
      ) : null}
      <Text style={styles.subtexto}>Tarjeta del Metropolitano</Text>
      <Text style={styles.titulo}>Hola, {perfil.nombre}</Text>

      <View style={styles.tarjetaSaldo}>
        <View style={styles.filaEntre}>
          <Text style={styles.tarjetaEtiqueta}>Saldo estimado</Text>
          <Text style={[styles.estado, bajo ? styles.estadoBajo : styles.estadoOk]}>{bajo ? 'Saldo bajo' : 'Saldo suficiente'}</Text>
        </View>
        <Text style={styles.saldo}>{soles(saldo)}</Text>
        <Text style={styles.tarjetaPred}>{textoPred}</Text>
        {prediccion.disponible && !prediccion.agotado ? (
          <Text style={styles.tarjetaEtiqueta}>
            Confianza {prediccion.confianza} · {prediccion.diasHistorial} días de historial
          </Text>
        ) : null}
      </View>

      <View style={styles.filaBotones}>
        <Boton titulo="Registrar viaje" onPress={() => irA('viaje')} estilo={{ flex: 1, marginRight: 8 }} />
        <Boton titulo="+ Registrar recarga" tipo="secundario" onPress={() => irA('recarga')} estilo={{ flex: 1 }} />
      </View>

      {prediccion.disponible && !prediccion.agotado ? (
        <View style={styles.tarjetaVerde}>
          <Text style={styles.tarjetaVerdeTitulo}>Sugerencia de recarga</Text>
          <Text style={styles.texto}>
            {sugerido > 0
              ? `Para los próximos 7 días necesitarías aprox. ${soles(prediccion.gasto7)}. Te sugerimos recargar al menos ${soles(Math.ceil(sugerido))}.`
              : `Tu saldo cubre el gasto estimado de los próximos 7 días (${soles(prediccion.gasto7)}).`}
          </Text>
        </View>
      ) : null}

      <Text style={styles.seccion}>Último movimiento</Text>
      {ultimo ? <ItemMovimiento m={ultimo} /> : <Text style={styles.texto}>Aún no hay movimientos.</Text>}

      <Text style={styles.nota}>El saldo es una estimación basada en tus registros. Si no coincide con el torniquete, corrígelo en Ajustes.</Text>
    </ScrollView>
  );
}

function ItemMovimiento({ m, onLongPress }) {
  const f = new Date(m.fecha);
  const titulos = {
    viaje: m.subtipo === 'integrada' ? 'Viaje integrado (alimentador + troncal)' : 'Viaje troncal',
    recarga: 'Recarga',
    inicial: 'Saldo inicial',
    ajuste: 'Corrección de saldo',
  };
  const signo = m.tipo === 'viaje' ? -m.monto : m.monto;
  return (
    <Pressable onLongPress={onLongPress} style={styles.item}>
      <View style={{ flex: 1 }}>
        <Text style={styles.itemTitulo}>{titulos[m.tipo]}</Text>
        <Text style={styles.subtexto}>
          {fechaCorta(f)} · {hora(f)}
        </Text>
      </View>
      <Text style={[styles.itemMonto, { color: signo < 0 ? ROJO : '#1A7F37' }]}>
        {signo < 0 ? '- ' : '+ '}
        {soles(Math.abs(signo))}
      </Text>
    </Pressable>
  );
}

function RegistrarViaje({ perfil, movimientos, onConfirmar, onVolver }) {
  const ultimoViaje = [...movimientos].filter((m) => m.tipo === 'viaje').sort((a, b) => new Date(b.fecha) - new Date(a.fecha))[0];
  const [subtipo, setSubtipo] = useState(ultimoViaje ? ultimoViaje.subtipo : 'troncal');
  const t = TARIFAS[perfil.tipoTarifa];
  const monto = t[subtipo];
  const saldo = calcularSaldo(movimientos);
  const ahora = new Date();

  const opcion = (clave, titulo, desc) => (
    <Pressable onPress={() => setSubtipo(clave)} style={[styles.opcion, subtipo === clave && styles.opcionActiva]}>
      <Text style={styles.itemTitulo}>
        {titulo} {subtipo === clave ? '✓' : ''}
      </Text>
      <Text style={styles.subtexto}>
        {desc} · {soles(t[clave])}
      </Text>
    </Pressable>
  );

  return (
    <ScrollView contentContainerStyle={styles.contenido}>
      <Encabezado titulo="Registrar viaje" onVolver={onVolver} />
      <Text style={styles.etiqueta}>¿Qué tipo de viaje fue?</Text>
      {opcion('troncal', 'Troncal', 'Bus articulado por la vía segregada')}
      {opcion('integrada', 'Integrada', 'Alimentador + troncal con un solo pago')}
      <View style={styles.caja}>
        <Fila etiqueta="Fecha y hora" valor={`Hoy, ${hora(ahora)}`} />
        <Fila etiqueta="Se descontará" valor={soles(monto)} />
        <Fila etiqueta="Saldo estimado después" valor={soles(saldo - monto)} negrita />
      </View>
      <Text style={styles.nota}>La tarifa se toma de tu configuración ({perfil.tipoTarifa === 'universitaria' ? 'medio pasaje' : 'general'}).</Text>
      <Boton titulo="Confirmar viaje" onPress={() => onConfirmar(subtipo, monto)} estilo={{ marginTop: 16 }} />
    </ScrollView>
  );
}

function RegistrarRecarga({ movimientos, onConfirmar, onVolver }) {
  const [monto, setMonto] = useState(20);
  const [otro, setOtro] = useState('');
  const saldo = calcularSaldo(movimientos);
  const valor = otro ? parseFloat(otro.replace(',', '.')) : monto;

  const confirmar = () => {
    if (isNaN(valor) || valor <= 0) return Alert.alert('Monto no válido', 'Ingresa un monto mayor a 0.');
    onConfirmar(Math.round(valor * 100) / 100);
  };

  return (
    <ScrollView contentContainerStyle={styles.contenido} keyboardShouldPersistTaps="handled">
      <Encabezado titulo="Registrar recarga" onVolver={onVolver} />
      <Text style={styles.etiqueta}>Montos rápidos</Text>
      <View style={styles.filaChips}>
        {[5, 10, 20, 30, 50].map((v) => (
          <Chip
            key={v}
            texto={`S/ ${v}`}
            activo={!otro && monto === v}
            onPress={() => {
              setMonto(v);
              setOtro('');
            }}
          />
        ))}
      </View>
      <Text style={styles.etiqueta}>Otro monto</Text>
      <TextInput style={styles.input} value={otro} onChangeText={setOtro} keyboardType="decimal-pad" placeholder="0.00" />
      <View style={styles.caja}>
        <Fila etiqueta="Monto recargado" valor={isNaN(valor) ? '—' : soles(valor)} />
        <Fila etiqueta="Saldo estimado después" valor={isNaN(valor) ? '—' : soles(saldo + valor)} negrita />
      </View>
      <Boton titulo="Confirmar recarga" onPress={confirmar} estilo={{ marginTop: 16 }} />
    </ScrollView>
  );
}

function CorregirSaldo({ movimientos, onConfirmar, onVolver }) {
  const [real, setReal] = useState('');
  const saldo = calcularSaldo(movimientos);
  const confirmar = () => {
    const v = parseFloat(real.replace(',', '.'));
    if (isNaN(v) || v < 0) return Alert.alert('Saldo no válido', 'Ingresa el saldo que ves en el torniquete o tótem.');
    onConfirmar(Math.round(v * 100) / 100);
  };
  return (
    <ScrollView contentContainerStyle={styles.contenido} keyboardShouldPersistTaps="handled">
      <Encabezado titulo="Corregir saldo" onVolver={onVolver} />
      <Text style={styles.texto}>Usa esta opción si el saldo de la app no coincide con el que ves en el torniquete o tótem.</Text>
      <View style={styles.caja}>
        <Fila etiqueta="Saldo estimado actual" valor={soles(saldo)} />
      </View>
      <Text style={styles.etiqueta}>Saldo real de tu tarjeta</Text>
      <TextInput style={[styles.input, styles.inputGrande]} value={real} onChangeText={setReal} keyboardType="decimal-pad" placeholder="0.00" />
      <Text style={styles.nota}>Se guardará la diferencia como una “corrección de saldo” en tu historial.</Text>
      <Boton titulo="Guardar saldo real" onPress={confirmar} estilo={{ marginTop: 16 }} />
    </ScrollView>
  );
}

function Historial({ movimientos, onEliminar }) {
  const [tipo, setTipo] = useState('todo');
  const [periodo, setPeriodo] = useState('mes');
  const hoy = inicioDelDia(new Date());
  const desde = periodo === 'semana' ? sumarDias(hoy, -diaSemana(hoy)) : periodo === 'mes' ? new Date(hoy.getFullYear(), hoy.getMonth(), 1) : new Date(0);

  const enPeriodo = movimientos.filter((m) => new Date(m.fecha) >= desde);
  const lista = enPeriodo
    .filter((m) => tipo === 'todo' || (tipo === 'viajes' ? m.tipo === 'viaje' : m.tipo === 'recarga'))
    .sort((a, b) => new Date(b.fecha) - new Date(a.fecha));
  const gastado = enPeriodo.filter((m) => m.tipo === 'viaje').reduce((s, m) => s + m.monto, 0);
  const recargado = enPeriodo.filter((m) => m.tipo === 'recarga').reduce((s, m) => s + m.monto, 0);

  const grupos = [];
  lista.forEach((m) => {
    const k = claveFecha(new Date(m.fecha));
    if (!grupos.length || grupos[grupos.length - 1].clave !== k) grupos.push({ clave: k, fecha: new Date(m.fecha), items: [] });
    grupos[grupos.length - 1].items.push(m);
  });

  const confirmarEliminar = (m) =>
    Alert.alert('Eliminar movimiento', '¿Deseas eliminar este movimiento? El saldo se recalculará.', [
      { text: 'Cancelar', style: 'cancel' },
      { text: 'Eliminar', style: 'destructive', onPress: () => onEliminar(m.id) },
    ]);

  return (
    <ScrollView contentContainerStyle={styles.contenido}>
      <Text style={styles.titulo}>Historial</Text>
      <View style={styles.filaChips}>
        <Chip texto="Todo" activo={tipo === 'todo'} onPress={() => setTipo('todo')} />
        <Chip texto="Viajes" activo={tipo === 'viajes'} onPress={() => setTipo('viajes')} />
        <Chip texto="Recargas" activo={tipo === 'recargas'} onPress={() => setTipo('recargas')} />
      </View>
      <View style={styles.filaChips}>
        <Chip texto="Esta semana" activo={periodo === 'semana'} onPress={() => setPeriodo('semana')} />
        <Chip texto="Este mes" activo={periodo === 'mes'} onPress={() => setPeriodo('mes')} />
        <Chip texto="Todo" activo={periodo === 'todo'} onPress={() => setPeriodo('todo')} />
      </View>
      <View style={styles.caja}>
        <Fila etiqueta="Total gastado en viajes" valor={soles(gastado)} negrita />
        <Fila etiqueta="Total recargado" valor={soles(recargado)} />
      </View>
      {grupos.length === 0 ? <Text style={styles.texto}>No hay movimientos en este periodo.</Text> : null}
      {grupos.map((g) => (
        <View key={g.clave}>
          <Text style={styles.grupo}>{g.clave === claveFecha(hoy) ? 'Hoy' : fechaCorta(g.fecha)}</Text>
          {g.items.map((m) => (
            <ItemMovimiento key={m.id} m={m} onLongPress={() => confirmarEliminar(m)} />
          ))}
        </View>
      ))}
      <Text style={styles.nota}>Mantén presionado un movimiento para eliminarlo si lo registraste por error.</Text>
    </ScrollView>
  );
}

function Estadisticas({ movimientos, prediccion }) {
  const hoy = inicioDelDia(new Date());
  const gastos = gastoPorDia(movimientos);
  const dias = Array.from({ length: 7 }, (_, i) => sumarDias(hoy, i - 6));
  const valores = dias.map((d) => gastos[claveFecha(d)] || 0);
  const maximo = Math.max(...valores, 1);
  const total = valores.reduce((a, b) => a + b, 0);

  return (
    <ScrollView contentContainerStyle={styles.contenido}>
      <Text style={styles.titulo}>Estadísticas</Text>
      <View style={styles.caja}>
        <Text style={styles.subtexto}>Gastado en los últimos 7 días</Text>
        <Text style={styles.tituloGrande}>{soles(total)}</Text>
        <View style={styles.grafico}>
          {dias.map((d, i) => (
            <View key={i} style={styles.barraCol}>
              <Text style={styles.barraValor}>{valores[i] ? valores[i].toFixed(2) : '0'}</Text>
              <View style={[styles.barra, { height: 6 + 110 * (valores[i] / maximo), backgroundColor: i === 6 ? ROJO : OSCURO }]} />
              <Text style={styles.barraDia}>{DIAS_TXT[d.getDay()]}</Text>
            </View>
          ))}
        </View>
      </View>

      <View style={styles.tarjetaSaldo}>
        <Text style={styles.tarjetaEtiqueta}>Predicción de saldo</Text>
        {prediccion.disponible && !prediccion.agotado ? (
          <>
            <Text style={styles.tarjetaPred}>
              {prediccion.fecha ? `Hasta aprox. ${fechaCorta(prediccion.fecha)}` : 'Más de 60 días'}
            </Text>
            <Text style={styles.tarjetaEtiqueta}>
              Método: {prediccion.metodo === 'regresion' ? 'regresión lineal' : 'promedio diario (pocos datos)'} · confianza {prediccion.confianza}
            </Text>
            <Text style={styles.tarjetaEtiqueta}>Basada en {prediccion.diasHistorial} días de historial. Con más registros, la estimación será más precisa.</Text>
          </>
        ) : (
          <Text style={styles.tarjetaPred}>{prediccion.mensaje}</Text>
        )}
      </View>
      <Text style={styles.nota}>
        Modelo: regresión lineal entrenada con datos sintéticos (simulados). Con menos de 7 días de historial se usa el promedio diario.
      </Text>
    </ScrollView>
  );
}

function Ajustes({ perfil, onCambiarPerfil, irA, onDemo, onBorrar }) {
  const [umbralTxt, setUmbralTxt] = useState(perfil.umbral.toFixed(2));
  const guardarUmbral = () => {
    const v = parseFloat(umbralTxt.replace(',', '.'));
    if (isNaN(v) || v < 0) return Alert.alert('Valor no válido', 'Ingresa un monto mayor o igual a 0.');
    onCambiarPerfil({ umbral: v });
    Alert.alert('Guardado', `Te avisaremos cuando tu saldo sea menor que ${soles(v)}.`);
  };
  return (
    <ScrollView contentContainerStyle={styles.contenido} keyboardShouldPersistTaps="handled">
      <Text style={styles.titulo}>Ajustes</Text>

      <Text style={styles.etiqueta}>Tipo de tarifa</Text>
      <View style={styles.filaChips}>
        <Chip texto="Medio pasaje" activo={perfil.tipoTarifa === 'universitaria'} onPress={() => onCambiarPerfil({ tipoTarifa: 'universitaria' })} />
        <Chip texto="General" activo={perfil.tipoTarifa === 'general'} onPress={() => onCambiarPerfil({ tipoTarifa: 'general' })} />
      </View>
      <Text style={styles.nota}>
        Troncal {soles(TARIFAS[perfil.tipoTarifa].troncal)} · Integrada {soles(TARIFAS[perfil.tipoTarifa].integrada)}
      </Text>

      <View style={[styles.caja, styles.filaEntre]}>
        <Text style={styles.itemTitulo}>Alertas de saldo bajo</Text>
        <Switch value={perfil.alertas} onValueChange={(v) => onCambiarPerfil({ alertas: v })} trackColor={{ true: ROJO }} />
      </View>
      <Text style={styles.etiqueta}>Avisarme si el saldo baja de (S/)</Text>
      <View style={styles.filaBotones}>
        <TextInput style={[styles.input, { flex: 1, marginRight: 8 }]} value={umbralTxt} onChangeText={setUmbralTxt} keyboardType="decimal-pad" />
        <Boton titulo="Guardar" tipo="secundario" onPress={guardarUmbral} />
      </View>

      <Boton titulo="Corregir saldo" tipo="secundario" onPress={() => irA('corregir')} estilo={{ marginTop: 16 }} />
      <Boton titulo="Cargar datos de demostración" tipo="secundario" onPress={onDemo} estilo={{ marginTop: 10 }} />
      <Boton titulo="Borrar todos mis datos" tipo="secundario" onPress={onBorrar} estilo={{ marginTop: 10 }} />

      <View style={styles.aviso}>
        <Text style={styles.avisoTitulo}>Acerca del saldo</Text>
        <Text style={styles.avisoTexto}>
          MetroSaldo no se conecta al sistema oficial del Metropolitano. El saldo es una estimación basada en los viajes y recargas que registras. Tus datos se guardan solo en este celular.
        </Text>
      </View>
      <Text style={[styles.nota, { textAlign: 'center' }]}>MetroSaldo · versión MVP (APF3)</Text>
    </ScrollView>
  );
}

// ---------------------------------------------------------------- App principal
export default function App() {
  const [cargado, setCargado] = useState(false);
  const [perfil, setPerfil] = useState(null);
  const [movimientos, setMovimientos] = useState([]);
  const [pestana, setPestana] = useState('inicio');
  const [modal, setModal] = useState(null); // 'viaje' | 'recarga' | 'corregir' | null

  useEffect(() => {
    AsyncStorage.getItem(CLAVE_DATOS)
      .then((txt) => {
        if (txt) {
          const datos = JSON.parse(txt);
          setPerfil(datos.perfil);
          setMovimientos(datos.movimientos || []);
        }
      })
      .catch(() => Alert.alert('Error', 'No se pudieron leer los datos guardados.'))
      .finally(() => setCargado(true));
  }, []);

  useEffect(() => {
    if (cargado) {
      AsyncStorage.setItem(CLAVE_DATOS, JSON.stringify({ perfil, movimientos })).catch(() => {});
    }
  }, [perfil, movimientos, cargado]);

  const prediccion = useMemo(() => (perfil ? calcularPrediccion(movimientos, perfil) : { disponible: false }), [movimientos, perfil]);

  const agregarMovimiento = (m) => {
    const nuevos = [...movimientos, { id: nuevoId(), fecha: new Date().toISOString(), ...m }];
    setMovimientos(nuevos);
    return calcularSaldo(nuevos);
  };

  const revisarAlerta = (saldoNuevo) => {
    if (perfil.alertas && saldoNuevo < perfil.umbral) {
      Alert.alert('Saldo bajo', `Tu saldo estimado es ${soles(saldoNuevo)}. Considera recargar antes de tu próximo viaje.`);
    }
  };

  const confirmarViaje = (subtipo, monto) => {
    const registrar = () => {
      const s = agregarMovimiento({ tipo: 'viaje', subtipo, monto });
      setModal(null);
      setPestana('inicio');
      revisarAlerta(s);
    };
    if (calcularSaldo(movimientos) < monto) {
      Alert.alert('Saldo insuficiente', 'Según tus registros, tu saldo no alcanza para este viaje. Si ya viajaste, quizá falta registrar una recarga o corregir tu saldo.', [
        { text: 'Cancelar', style: 'cancel' },
        { text: 'Registrar igual', onPress: registrar },
      ]);
    } else {
      registrar();
    }
  };

  const confirmarRecarga = (monto) => {
    agregarMovimiento({ tipo: 'recarga', monto });
    setModal(null);
    setPestana('inicio');
  };

  const confirmarCorreccion = (real) => {
    const diferencia = Math.round((real - calcularSaldo(movimientos)) * 100) / 100;
    if (diferencia !== 0) agregarMovimiento({ tipo: 'ajuste', monto: diferencia });
    setModal(null);
    Alert.alert('Saldo corregido', `Tu saldo ahora es ${soles(real)}.`);
  };

  const crearPerfil = ({ nombre, tipoTarifa, saldo }) => {
    setPerfil({ nombre, tipoTarifa, umbral: TARIFAS[tipoTarifa].troncal, alertas: true, demo: false });
    setMovimientos([{ id: nuevoId(), tipo: 'inicial', monto: saldo, fecha: new Date().toISOString() }]);
  };

  const cargarDemo = () =>
    Alert.alert('Datos de demostración', 'Se reemplazarán tus datos por 21 días de movimientos simulados. ¿Continuar?', [
      { text: 'Cancelar', style: 'cancel' },
      {
        text: 'Cargar',
        onPress: () => {
          setMovimientos(generarDemo(perfil.tipoTarifa));
          setPerfil({ ...perfil, demo: true });
          setPestana('inicio');
        },
      },
    ]);

  const borrarTodo = () =>
    Alert.alert('Borrar datos', 'Se eliminarán tu perfil y todos tus movimientos. ¿Continuar?', [
      { text: 'Cancelar', style: 'cancel' },
      {
        text: 'Borrar',
        style: 'destructive',
        onPress: () => {
          setPerfil(null);
          setMovimientos([]);
          setPestana('inicio');
        },
      },
    ]);

  if (!cargado) {
    return (
      <View style={[styles.pantalla, { justifyContent: 'center', alignItems: 'center' }]}>
        <Text style={styles.texto}>Cargando…</Text>
      </View>
    );
  }

  let contenido;
  if (!perfil) {
    contenido = <Bienvenida onGuardar={crearPerfil} />;
  } else if (modal === 'viaje') {
    contenido = <RegistrarViaje perfil={perfil} movimientos={movimientos} onConfirmar={confirmarViaje} onVolver={() => setModal(null)} />;
  } else if (modal === 'recarga') {
    contenido = <RegistrarRecarga movimientos={movimientos} onConfirmar={confirmarRecarga} onVolver={() => setModal(null)} />;
  } else if (modal === 'corregir') {
    contenido = <CorregirSaldo movimientos={movimientos} onConfirmar={confirmarCorreccion} onVolver={() => setModal(null)} />;
  } else if (pestana === 'historial') {
    contenido = <Historial movimientos={movimientos} onEliminar={(id) => setMovimientos(movimientos.filter((m) => m.id !== id))} />;
  } else if (pestana === 'estadisticas') {
    contenido = <Estadisticas movimientos={movimientos} prediccion={prediccion} />;
  } else if (pestana === 'ajustes') {
    contenido = (
      <Ajustes
        perfil={perfil}
        onCambiarPerfil={(cambios) => setPerfil({ ...perfil, ...cambios })}
        irA={setModal}
        onDemo={cargarDemo}
        onBorrar={borrarTodo}
      />
    );
  } else {
    contenido = <Inicio perfil={perfil} movimientos={movimientos} prediccion={prediccion} irA={setModal} />;
  }

  const pestanas = [
    ['inicio', 'Inicio'],
    ['historial', 'Historial'],
    ['estadisticas', 'Estadísticas'],
    ['ajustes', 'Ajustes'],
  ];

  return (
    <View style={styles.pantalla}>
      <StatusBar barStyle="dark-content" />
      <View style={{ flex: 1 }}>{contenido}</View>
      {perfil && !modal ? (
        <View style={styles.barraTabs}>
          {pestanas.map(([clave, texto]) => (
            <Pressable key={clave} onPress={() => setPestana(clave)} style={styles.tab}>
              <Text style={[styles.tabTexto, pestana === clave && styles.tabActivo]}>{texto}</Text>
            </Pressable>
          ))}
        </View>
      ) : null}
    </View>
  );
}

// ---------------------------------------------------------------- Estilos
const styles = StyleSheet.create({
  pantalla: { flex: 1, backgroundColor: '#F4F5F7', paddingTop: (StatusBar.currentHeight || 0) + 12 },
  contenido: { padding: 20, paddingBottom: 40 },
  logo: { fontSize: 18, fontWeight: '700', color: ROJO, marginBottom: 16 },
  titulo: { fontSize: 24, fontWeight: '700', color: OSCURO, marginBottom: 12 },
  tituloGrande: { fontSize: 28, fontWeight: '800', color: OSCURO, marginVertical: 8 },
  texto: { fontSize: 15, color: '#424a53', lineHeight: 21 },
  subtexto: { fontSize: 13, color: '#6e7781' },
  nota: { fontSize: 12, color: '#6e7781', marginTop: 12, lineHeight: 17 },
  etiqueta: { fontSize: 14, fontWeight: '600', color: OSCURO, marginTop: 18, marginBottom: 8 },
  seccion: { fontSize: 16, fontWeight: '700', color: OSCURO, marginTop: 24, marginBottom: 8 },
  input: { backgroundColor: '#fff', borderWidth: 1, borderColor: '#d0d7de', borderRadius: 12, paddingHorizontal: 14, paddingVertical: 12, fontSize: 16 },
  inputGrande: { fontSize: 28, fontWeight: '700' },
  boton: { borderRadius: 12, paddingVertical: 14, paddingHorizontal: 16, alignItems: 'center' },
  botonPrimario: { backgroundColor: ROJO },
  botonSecundario: { backgroundColor: '#fff', borderWidth: 1, borderColor: OSCURO },
  botonTextoPrimario: { color: '#fff', fontWeight: '700', fontSize: 15 },
  botonTextoSecundario: { color: OSCURO, fontWeight: '700', fontSize: 15 },
  filaChips: { flexDirection: 'row', flexWrap: 'wrap', marginBottom: 6 },
  chip: { borderWidth: 1, borderColor: '#d0d7de', backgroundColor: '#fff', borderRadius: 20, paddingVertical: 8, paddingHorizontal: 14, marginRight: 8, marginBottom: 8 },
  chipActivo: { backgroundColor: OSCURO, borderColor: OSCURO },
  chipTexto: { color: OSCURO, fontSize: 14 },
  chipTextoActivo: { color: '#fff', fontWeight: '700' },
  aviso: { backgroundColor: '#FFF8E1', borderRadius: 12, padding: 14, marginTop: 16 },
  avisoDemo: { backgroundColor: '#E7F0FF', borderRadius: 12, padding: 10, marginBottom: 12 },
  avisoTitulo: { fontWeight: '700', color: '#7a5a00', marginBottom: 4 },
  avisoTexto: { color: '#5c4a00', fontSize: 13, lineHeight: 18 },
  tarjetaSaldo: { backgroundColor: OSCURO, borderRadius: 18, padding: 18, marginTop: 8 },
  tarjetaEtiqueta: { color: '#c9d1d9', fontSize: 13, marginTop: 4 },
  tarjetaPred: { color: '#fff', fontSize: 17, fontWeight: '700', marginTop: 10 },
  saldo: { color: '#fff', fontSize: 40, fontWeight: '800', marginTop: 6 },
  estado: { fontSize: 12, fontWeight: '700', paddingHorizontal: 10, paddingVertical: 4, borderRadius: 12, overflow: 'hidden' },
  estadoOk: { backgroundColor: '#DAFBE1', color: '#1A7F37' },
  estadoBajo: { backgroundColor: '#FFEBE9', color: ROJO },
  filaEntre: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  filaBotones: { flexDirection: 'row', marginTop: 16, alignItems: 'center' },
  tarjetaVerde: { backgroundColor: '#E6F4EA', borderRadius: 12, padding: 14, marginTop: 16 },
  tarjetaVerdeTitulo: { fontWeight: '700', color: '#1A7F37', marginBottom: 4 },
  item: { flexDirection: 'row', alignItems: 'center', backgroundColor: '#fff', borderRadius: 12, padding: 14, marginBottom: 8 },
  itemTitulo: { fontSize: 15, fontWeight: '600', color: OSCURO },
  itemMonto: { fontSize: 15, fontWeight: '700' },
  grupo: { fontSize: 13, color: '#6e7781', marginTop: 12, marginBottom: 6 },
  encabezado: { flexDirection: 'row', alignItems: 'center', marginBottom: 4 },
  volver: { width: 36, height: 36, borderRadius: 18, backgroundColor: '#fff', alignItems: 'center', justifyContent: 'center', marginRight: 10, marginBottom: 12 },
  volverTexto: { fontSize: 24, color: OSCURO, marginTop: -2 },
  opcion: { backgroundColor: '#fff', borderRadius: 12, padding: 14, marginBottom: 10, borderWidth: 1, borderColor: '#d0d7de' },
  opcionActiva: { borderColor: ROJO, borderWidth: 2, backgroundColor: '#FFF5F6' },
  caja: { backgroundColor: '#fff', borderRadius: 12, padding: 14, marginTop: 16 },
  fila: { flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 6 },
  filaEtiqueta: { color: '#6e7781', fontSize: 14 },
  filaValor: { color: OSCURO, fontSize: 14 },
  grafico: { flexDirection: 'row', alignItems: 'flex-end', justifyContent: 'space-between', height: 150, marginTop: 12 },
  barraCol: { alignItems: 'center', flex: 1 },
  barra: { width: 22, borderRadius: 6 },
  barraValor: { fontSize: 10, color: '#6e7781', marginBottom: 4 },
  barraDia: { fontSize: 12, color: '#6e7781', marginTop: 6 },
  barraTabs: { flexDirection: 'row', backgroundColor: '#fff', borderTopWidth: 1, borderTopColor: '#d0d7de', paddingBottom: 18, paddingTop: 10 },
  tab: { flex: 1, alignItems: 'center' },
  tabTexto: { fontSize: 13, color: '#6e7781' },
  tabActivo: { color: ROJO, fontWeight: '700' },
});
