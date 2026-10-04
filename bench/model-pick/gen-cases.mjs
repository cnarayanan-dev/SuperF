// Generates cases.json (kept as a script so the text is easy to edit).
import { writeFileSync } from 'node:fs';
const pages = [
  { id: 'docs-en', lang: 'en', title: 'Relay CLI documentation', chunks: [
    'Install the Relay CLI with npm install -g relay-cli. The tool requires Node 18 or newer.',
    'Run relay login to authenticate. A browser window opens and asks you to approve the session. Tokens are stored in your home directory.',
    'Project settings live in relay.config.json at the repository root. You can set the region, the build command and the output folder.',
    'Secrets such as API keys should be added as environment variables. Never commit them to version control.',
    'Run relay deploy to publish your project. The first deployment usually takes about two minutes.',
    'If a release breaks production, run relay rollback to restore the previous version. Rollbacks complete within seconds.',
    'Attach your own domain under Settings, then add the provided CNAME record at your DNS provider. Certificates are issued automatically.',
    'Static assets are cached at the edge for one hour by default. Use the cache-control header to change the duration.',
    'Stream live output with relay logs --follow. Logs are retained for seven days.',
    'The free plan includes 100 GB of bandwidth per month. Additional traffic costs five dollars per 100 GB.',
    'To close your account, open Billing and choose Delete team. All projects and deployments are removed permanently.',
    'If a build fails with exit code 137, the process ran out of memory. Reduce parallel jobs or upgrade to a larger build machine.' ] },
  { id: 'news-en', lang: 'en', title: 'City council approves bike lane plan', chunks: [
    'The city council voted on Tuesday to approve a 40 million dollar plan to expand protected bike lanes across the downtown area.',
    'Supporters say the new network will cut traffic injuries and encourage more residents to commute without a car.',
    'Shop owners on Harbor Street voiced concern that removing parking spaces could reduce foot traffic and hurt sales.',
    'Mayor Elena Ortiz defended the proposal, pointing to a pilot project last year in which cycling trips rose by 35 percent.',
    'Construction is scheduled to begin in March and finish within eighteen months, depending on the weather.',
    'Funding will come from a state transportation grant and a municipal bond that voters approved in 2023.',
    'Critics from the opposition party argued that the money would be better spent on repairing crumbling roads and bridges.',
    'Cycling advocates have campaigned for safer streets since a cyclist was killed at the Main Street intersection two years ago.',
    'The plan also includes new bike-share stations, with electric bicycles available at twenty locations.',
    'Public transit officials said they would coordinate bus schedules so that routes are not disrupted during construction.',
    'A public hearing will be held next month, where residents can submit written comments about the final route design.',
    'Similar projects in Copenhagen and Utrecht have been credited with lowering emissions and improving air quality.' ] },
  { id: 'library-de', lang: 'de', title: 'Stadtbibliothek: Häufige Fragen', chunks: [
    'Die Stadtbibliothek ist von Montag bis Freitag von 10 bis 19 Uhr geöffnet. Samstags schließen wir um 16 Uhr.',
    'Für einen Bibliotheksausweis benötigen Sie einen gültigen Personalausweis und eine Meldebescheinigung.',
    'Die Jahresgebühr beträgt 20 Euro für Erwachsene. Kinder und Jugendliche unter 18 Jahren zahlen nichts.',
    'Bücher können für vier Wochen ausgeliehen werden. Danach muss das Medium zurückgegeben oder verlängert werden.',
    'Die Verlängerung ist online über Ihr Benutzerkonto oder telefonisch möglich. Pro Medium sind zwei Verlängerungen erlaubt.',
    'Bei verspäteter Rückgabe fällt eine Mahngebühr von 50 Cent pro Tag und Medium an.',
    'Im Lesesaal im ersten Stock stehen ruhige Arbeitsplätze mit kostenlosem WLAN zur Verfügung.',
    'Wenn ein Buch verloren geht oder beschädigt wird, müssen Sie den Ersatz bezahlen.',
    'Jeden zweiten Donnerstag im Monat findet eine Lesung für Kinder statt. Eine Anmeldung ist nicht nötig.',
    'Die digitale Bibliothek bietet E-Books und Hörbücher, die Sie rund um die Uhr herunterladen können.',
    'Mit dem Kopierer im Erdgeschoss können Sie Seiten für zehn Cent drucken. Bezahlt wird mit Münzen.',
    'Eine Kündigung der Mitgliedschaft ist jederzeit schriftlich oder per E-Mail möglich.' ] },
];
// [page, chunkIndex, category, query, queryLang]
const q = [
  ['docs-en',6,'exact','CNAME record','en'], ['docs-en',5,'exact','relay rollback','en'], ['docs-en',3,'exact','environment variables','en'],
  ['docs-en',1,'typo','autentication','en'], ['docs-en',9,'typo','bandwith','en'], ['docs-en',6,'typo','certifcates','en'],
  ['docs-en',0,'variant','installing','en'], ['docs-en',2,'variant','configuration file','en'], ['docs-en',7,'variant','caches','en'],
  ['docs-en',1,'synonym','sign in','en'], ['docs-en',5,'synonym','undo a release','en'], ['docs-en',9,'synonym','extra traffic charges','en'],
  ['docs-en',10,'paraphrase','how to delete my account','en'], ['docs-en',11,'paraphrase','why did my build get killed','en'],
  ['docs-en',8,'paraphrase','how long are old logs kept','en'], ['docs-en',3,'paraphrase','where do I put my API keys safely','en'],
  ['news-en',8,'exact','bike-share stations','en'], ['news-en',2,'exact','Harbor Street','en'], ['news-en',5,'exact','state transportation grant','en'],
  ['news-en',3,'typo','Ortitz','en'], ['news-en',4,'typo','contruction','en'], ['news-en',11,'typo','Copenhagn','en'],
  ['news-en',0,'variant','bicycle lanes','en'], ['news-en',7,'variant','cycle advocate','en'],
  ['news-en',2,'synonym','shopkeepers','en'], ['news-en',0,'synonym','lawmakers approved','en'], ['news-en',8,'synonym','e-bikes','en'],
  ['news-en',5,'paraphrase','who pays for the project','en'], ['news-en',4,'paraphrase','when will the work be finished','en'],
  ['news-en',10,'paraphrase','can the public give feedback','en'], ['news-en',9,'paraphrase','will buses be affected','en'],
  ['library-de',6,'exact','Lesesaal','de'], ['library-de',5,'exact','Mahngebühr','de'],
  ['library-de',1,'typo','Bibliotheksauswies','de'], ['library-de',9,'typo','Hörbücer','de'],
  ['library-de',9,'variant','Hoerbuecher','de'], ['library-de',3,'variant','ausleihen','de'],
  ['library-de',11,'synonym','Abo beenden','de'], ['library-de',3,'synonym','Leihfrist','de'], ['library-de',2,'synonym','Kosten pro Jahr','de'],
  ['library-de',3,'paraphrase','Wie lange darf ich ein Buch behalten','de'], ['library-de',7,'paraphrase','Was passiert wenn ich ein Buch kaputt mache','de'],
  ['library-de',0,'paraphrase','Wann hat die Bücherei am Wochenende auf','de'],
  ['library-de',5,'synonym','late return fee','en'], ['library-de',0,'paraphrase','opening hours','en'],
  ['library-de',9,'synonym','e-books and audiobooks','en'], ['library-de',4,'paraphrase','how to renew a loan','en'],
];
const queries = q.map(([page, chunk, category, text, lang], i) => ({
  id: 'q' + (i + 1), page, chunk, category, query: text, lang,
  crossLanguage: lang !== pages.find(p => p.id === page).lang }));
writeFileSync('cases.json', JSON.stringify({ pages, queries }, null, 1));
console.log(queries.length, 'queries');
