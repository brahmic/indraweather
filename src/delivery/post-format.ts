import { escapeHtml } from "../domain/bulletin.js";

export function formatPostHtml(
  content: string,
  pointNames: string[],
  includeTitle = true,
): string {
  return content.split("\n").map((line, index) => {
    if (!line) return "";
    if (includeTitle && index === 0) return `🌊 <b>${escapeHtml(line)}</b>`;
    if (line === "Волна и вода") return `🌊 <b>${escapeHtml(line)}</b>`;

    const pointName = pointNames.find((name) => line === name || line.startsWith(`${name}:`));
    if (pointName) {
      const remainder = line.slice(pointName.length);
      return `📍 <b>${escapeHtml(pointName)}${remainder.startsWith(":") ? ":" : ""}</b>${escapeHtml(remainder.replace(/^:/u, ""))}`;
    }

    const labelled = formatLabel(line);
    return labelled ?? escapeHtml(line);
  }).join("\n");
}

function formatLabel(line: string): string | null {
  const labels: Array<[prefix: string, icon: string, wholeLine?: boolean]> = [
    ["Официальное предупреждение", "⚠️", true],
    ["Официальные предупреждения:", "⚠️"],
    ["Неполные данные:", "⚠️"],
    ["Главное:", "📌"],
    ["Главное", "📌", true],
    ["Сформировано:", "🕒"],
    ["Верхняя граница моделей:", "🌬️"],
    ["Согласованность:", "🔎"],
    ["Контрольные точки", "📍", true],
    ["Диапазоны:", "ℹ️"],
    ["Сводный коридор ECMWF/GFS", "🌬️", true],
    ["Обстановка", "🧭", true],
    ["Поворот ветра:", "🧭"],
    ["Модели:", "🔎"],
    ["Давление:", "📈"],
    ["Следующие 24 часа:", "⏱️"],
    ["Период 24–48 часов:", "⏱️"],
    ["Прилив:", "🌊"],
    ["Выпуск", "🗓️", true],
    ["Изменение:", "🔄"],
    ["Следующий выпуск:", "🕒"],
    ["Детальный снимок Sentinel-3 пропущен:", "🛰️"],
    ["Подробности по моделям:", "🔬"],
    ["Период:", "🗓️"],
    ["ECMWF:", "  •"],
    ["GFS:", "  •"],
    ["Расхождение:", "  ↔"],
    ["Итог сравнения:", "📊"],
    ["Источники", "ℹ️", true],
    ["Погода:", "  •"],
    ["Приливы:", "  •"],
    ["Ветер", "  •"],
    ["Осадки", "  •"],
    ["Видимость", "  •"],
    ["Температура", "  •"],
    ["Данные:", "ℹ️"],
    ["Источник:", "ℹ️"],
  ];
  const match = labels.find(([prefix]) => line.startsWith(prefix));
  if (!match) return null;
  const [prefix, icon, wholeLine] = match;
  if (wholeLine) return `${icon} <b>${escapeHtml(line)}</b>`;
  return `${icon} <b>${escapeHtml(prefix)}</b>${escapeHtml(line.slice(prefix.length))}`;
}

export function splitText(content: string, limit: number): string[] {
  if (content.length <= limit) return [content];
  const chunks: string[] = [];
  let current = "";
  for (const line of content.split("\n")) {
    const candidate = current ? `${current}\n${line}` : line;
    if (candidate.length <= limit) {
      current = candidate;
      continue;
    }
    if (current) chunks.push(current);
    if (line.length <= limit) {
      current = line;
      continue;
    }
    for (let offset = 0; offset < line.length; offset += limit) {
      chunks.push(line.slice(offset, offset + limit));
    }
    current = "";
  }
  if (current) chunks.push(current);
  return chunks;
}
