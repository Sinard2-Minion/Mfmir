FROM php:8.2-apache

# Устанавливаем рабочую директорию
WORKDIR /var/www/html

# Копируем все файлы сайта в контейнер
COPY . .

# Создаем папку для данных и даем права на запись (на случай, если диск не примонтирован)
RUN mkdir -p /var/data && chmod 777 /var/data

# Включаем модуль rewrite для Apache (часто нужен для PHP-сайтов)
RUN a2enmod rewrite

# Открываем порт (Render автоматически определяет его, но для ясности)
EXPOSE 80

# Запускаем Apache
CMD ["apache2-foreground"]