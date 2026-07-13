export type PersonalAnimationRequestStatus = "queued" | "cached" | "unavailable";

export function formatPersonalCloudMotionStatus(results: PersonalAnimationRequestStatus[]): string {
  const available = results.filter((result) => result !== "unavailable");
  if (available.length === 0) {
    return "Анимации пока недоступны: недостаточно кадров или персональная обработка выключена.";
  }
  if (results.includes("queued")) {
    return available.length === 1
      ? "⏳ Собираю анимацию для вашего охвата. Ролик придёт отдельным сообщением."
      : "⏳ Собираю анимации для вашего охвата. Ролики придут отдельными сообщениями.";
  }
  return available.length === 1
    ? "⏳ Отправляю готовую анимацию для вашего охвата."
    : "⏳ Отправляю готовые анимации для вашего охвата.";
}
