Hol deinen TrueNAS-Server in Homey.

TrueNAS Manager verbindet sich über dein lokales Netzwerk mit deinem TrueNAS-SCALE-System und macht daraus Homey-Geräte, die du überwachen und automatisieren kannst. Füge nur hinzu, was dich interessiert: das System selbst, einzelne Speicher-Pools, einzelne Festplatten, Systemdienste, Docker-Apps und virtuelle Maschinen.

WAS DU ÜBERWACHEN KANNST

System: CPU-Auslastung und -Temperatur, Systemlast, Speicherauslastung, ZFS-ARC-Grösse, Netzwerkdurchsatz, Laufzeit, TrueNAS-Version, ausstehende System-Updates und aktive Meldungen.

Speicher-Pools: Pool-Status, belegter und freier Speicher in TB und Prozent sowie der laufende Scrub-Fortschritt. Verlässt ein Pool den fehlerfreien Zustand, wird ein Alarm gesetzt.

Festplatten: Temperatur je Platte, Kapazität, Modell und zugehöriger Pool, mit konfigurierbarem Temperaturalarm.

Dienste: ob SMB, NFS, SSH, iSCSI und die übrigen laufen und ob sie beim Hochfahren starten.

Apps: Status und Version jeder Docker-App und ob ein Update bereitliegt.

Virtuelle Maschinen: Status, zugewiesener Arbeitsspeicher und virtuelle CPUs.

WAS DU STEUERN KANNST

Dienste starten, stoppen und neu starten. Apps starten, stoppen, neu bereitstellen und aktualisieren. Virtuelle Maschinen starten, stoppen und neu starten. Pool-Scrub starten und stoppen. Das gesamte NAS neu starten oder herunterfahren.

FLOW-KARTEN

Auslöser für neue Meldungen, verfügbare System- und App-Updates, Pool-Statuswechsel, einen Pool der nicht mehr in Ordnung ist, freien Speicher unter einem selbst gewählten Schwellwert, Start und Abschluss eines Scrubs, steigende Festplattentemperatur sowie Statuswechsel von Apps und VMs.

Bedingungen für Pool-Zustand, freien Speicher, laufende Scrubs, Festplattentemperatur, CPU-Auslastung, laufende Dienste, Apps und virtuelle Maschinen sowie ausstehende Updates.

Aktionen für alle oben genannten Steuerungen.

Schwellwert-Auslöser feuern einmal beim Über- bzw. Unterschreiten und nicht bei jeder Messung darüber hinaus. So überflutet eine heisse Platte oder ein voller Pool deine Zeitleiste nicht.

VORAUSSETZUNGEN

- TrueNAS SCALE 25.04 (Fangtooth) oder neuer. Die App nutzt die JSON-RPC-API, die ältere Versionen nicht anbieten.
- Ein API-Schlüssel, erstellt im TrueNAS-Webinterface unter Anmeldedaten, API-Schlüssel. Das Konto hinter dem Schlüssel benötigt Lesezugriff sowie Schreibzugriff für die Aktionen, die du nutzen möchtest.
- Homey und TrueNAS im selben lokalen Netzwerk. Eine feste Adresse für das NAS wird empfohlen.

SO FUNKTIONIERT ES

Füge zuerst das Gerät «TrueNAS System» hinzu und gib Adresse und API-Schlüssel ein. Alles Weitere wird von dort aus gefunden, du gibst den Schlüssel also nie zweimal ein. Alle Geräte eines NAS teilen sich eine Verbindung und einen Abfragezyklus, zwanzig Geräte kosten also weiterhin eine Abfrage pro Intervall.

Festplattentemperaturen werden in einem eigenen, langsameren Takt gelesen, weil dafür SMART abgefragt wird und das die Platten am Herunterfahren hindern kann. Dieses Intervall lässt sich in den Einstellungen des Systemgeräts erhöhen.

DATENSCHUTZ

Die App kommuniziert ausschliesslich mit deinem NAS im lokalen Netzwerk. Es verlassen keine Daten dein Zuhause.
