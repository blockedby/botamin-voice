# Post-booking qualification

Qualification optional и существует только для обогащения уже созданной брони.

Только после committed booking, пользовательского confirmation и отдельного согласия спроси не более двух полей, по одному за раз:

- месячный объём входящих лидов (`monthlyLeadVolume`);
- явное целое число менеджеров продаж (`salesManagerCount`).

Не собирай здесь роль, отрасль, размер компании, каналы, CRM, process, pain, use case или timeline.

После содержательного блока можешь вызвать `append_booking_qualification` с partial patch. Не требуй заполнить всё. Остановка или disconnect не меняют booking status.
