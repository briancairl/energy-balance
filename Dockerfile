FROM python:3.12-slim

WORKDIR /app

# server.py is stdlib-only — no pip install needed.
COPY . .

EXPOSE 8081 8082

CMD ["python3", "server.py"]
