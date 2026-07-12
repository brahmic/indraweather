# Развёртывание на production

Для MVP достаточно одного Linux-сервера с Docker Engine и Docker Compose.
Telegram используется через long polling. MAX использует production webhook,
поэтому для него необходимы домен, HTTPS и reverse proxy на порту 443.

## 1. Подготовка сервера

Установить Docker Engine и Compose plugin по официальной инструкции для своего
дистрибутива. На firewall оставить только SSH или другие административные
порты, необходимые владельцу сервера.

## 2. Получение проекта

```bash
git clone <repository-url> indra
cd indra
cp .env.example .env
```

Сгенерировать пароль PostgreSQL:

```bash
openssl rand -hex 32
```

Записать его в `POSTGRES_PASSWORD` файла `.env`, затем заполнить:

* `TELEGRAM_BOT_TOKEN`;
* `MAX_BOT_TOKEN`;
* `MAX_PUBLIC_BASE_URL`, например `https://weather.example.ru`;
* `STORMGLASS_API_KEY`.

`MAX_BOT_TOKEN` и `MAX_PUBLIC_BASE_URL` задаются только вместе. Секрет webhook
стабильно вычисляется из токена и в `.env` не хранится. Адрес MAX API
`https://platform-api2.max.ru` зафиксирован в коде.

Команда `/radar` требует отдельный бесплатный OAuth Client в Copernicus Data
Space: в Sentinel Hub Dashboard создать клиент типа `Client Credentials` и
записать его значения в `.env` как `COPERNICUS_CLIENT_ID` и
`COPERNICUS_CLIENT_SECRET`. Без обоих значений приложение запускается штатно,
но `/radar` сообщит, что радар не настроен. Не используйте тестовые публичные
учётные данные Copernicus в production.

Для исходящих запросов к MAX Docker image устанавливает официальный
`Russian Trusted Root CA` Минцифры из `certs/russian_trusted_root_ca.crt`.
Это отдельная цепочка доверия MAX API: сертификат на вашем поддомене нужен для
входящего webhook, но не заменяет корневой сертификат внутри контейнера.
Источник сертификата: `https://www.gosuslugi.ru/crt`; SHA-256 fingerprint:
`D2:6D:2D:02:31:B7:C3:9F:92:CC:73:85:12:BA:54:10:35:19:E4:40:5D:68:B5:BD:70:3E:97:88:CA:8E:CF:31`.

Спутниковый источник EUMETSAT не требует ключа. Исходящее HTTPS-соединение с
`view.eumetsat.int`, `api.eumetsat.int` и `service.eumetsat.int` должно быть
разрешено. При недоступности источника выпуск продолжается без изображения и с
указанием причины пропуска детального кадра.

Фоновая очередь спутниковой анимации собирает ИК-кадр каждые 20 минут. Кадры и
короткие MP4 хранятся в отдельном именованном Docker volume `indra_satellite_animation`,
в PostgreSQL остаются только метаданные и статусы очереди. Используется
скользящее окно не более 12 часов, а старые данные удаляются после 26 часов.
Первые анимации появляются после трёх успешных кадров; полный диапазон набирается
за первые сутки работы. `ffmpeg` уже включён в Docker image.

Файл `.env` не должен передаваться в Git, Docker image или систему логирования.

## 3. Запуск

Перед production-запуском остановить локальный экземпляр с тем же Telegram-
токеном. Два long-polling процесса для одного бота будут конфликтовать.

```bash
docker compose up -d --build
docker compose ps
docker compose logs --tail=100 app
```

Оба контейнера должны перейти в состояние `healthy`. Проверка приложения не
публикуется наружу и выполняется внутри Docker-сети:

```bash
docker compose exec app wget -qO- http://127.0.0.1:3000/health/ready
```

Ожидаемый ответ: `{"status":"ready"}`.

### Reverse proxy для MAX

Compose публикует HTTP приложения только на `127.0.0.1:3000`. Если этот порт
занят, внешний порт можно изменить через `APP_HTTP_PORT`, не меняя внутренний
порт контейнера.

Пример location для Nginx:

```nginx
location = /webhooks/max {
    proxy_pass http://127.0.0.1:3000;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-Proto https;
    proxy_connect_timeout 5s;
    proxy_read_timeout 30s;
}
```

После применения конфигурации Nginx запрос без секрета должен достигать
приложения и получать `401`:

```bash
curl -i -X POST "${MAX_PUBLIC_BASE_URL}/webhooks/max" \
  -H 'Content-Type: application/json' \
  -d '{}'
```

При старте приложение проверяет токен MAX, публикует список команд и
регистрирует webhook. Успешный запуск виден в логах как `MAX bot started`.
Ошибка `unable to get local issuer certificate` означает, что запущен старый
image: пересоберите его командой `docker compose up -d --build`.

## 4. Обновление

```bash
git pull --ff-only
docker compose up -d --build
docker compose ps
```

Миграции выполняются приложением автоматически до запуска планировщика и
каналов доставки.

## 5. Расположение базы данных

PostgreSQL хранит данные не в репозитории и не внутри временного слоя
контейнера. Compose создаёт именованный Docker volume:

```text
indra_postgres_data
```

Он подключён в контейнер PostgreSQL по пути:

```text
/var/lib/postgresql/data
```

На обычном Linux Docker Engine физический каталог обычно находится под
`/var/lib/docker/volumes/indra_postgres_data/_data`. В Docker Desktop volume
расположен внутри служебной Linux VM. Работать с файлами PostgreSQL напрямую не
следует; состояние volume можно посмотреть командой:

```bash
docker volume inspect indra_postgres_data
```

Команды `docker compose up`, пересборка image и удаление контейнера volume не
удаляют. Команда `docker compose down -v` удалит volume вместе со всей базой и в
production использоваться не должна.

Спутниковые кадры хранятся отдельно:

```text
indra_satellite_animation
```

Этот volume не содержит прогнозную БД и очищается приложением автоматически по
сроку хранения. Его также не следует удалять через `docker compose down -v`,
если нужно сохранить накопленные кадры до следующего запуска.

## 6. Диагностика

```bash
docker compose ps
docker compose logs --tail=200 app
docker compose logs --tail=200 postgres
docker compose exec postgres pg_isready -U "$POSTGRES_USER" -d "$POSTGRES_DB"
```

После развёртывания пользователи должны отдельно запустить ботов в Telegram и
MAX. Подписки хранятся независимо как `telegram / user_id` и `max / user_id`.
