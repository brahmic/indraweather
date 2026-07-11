# Развёртывание на production

Для MVP достаточно одного Linux-сервера с Docker Engine и Docker Compose.
Telegram используется через long polling, поэтому домен, TLS-сертификат и
открытые входящие HTTP-порты приложению не нужны.

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
* `STORMGLASS_API_KEY`.

Спутниковый источник EUMETSAT не требует ключа. Исходящее HTTPS-соединение с
`view.eumetsat.int`, `api.eumetsat.int` и `service.eumetsat.int` должно быть
разрешено. При недоступности источника выпуск продолжается без изображения и с
указанием причины пропуска детального кадра.

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

## 4. Обновление

```bash
git pull --ff-only
docker compose up -d --build
docker compose ps
```

Миграции выполняются приложением автоматически до запуска планировщика и
Telegram-бота.

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

## 6. Диагностика

```bash
docker compose ps
docker compose logs --tail=200 app
docker compose logs --tail=200 postgres
docker compose exec postgres pg_isready -U "$POSTGRES_USER" -d "$POSTGRES_DB"
```

После развёртывания пользователи должны отправить боту `/start`, поскольку новая
production-база изначально не содержит подписчиков.
