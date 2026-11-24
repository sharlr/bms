-- Horn of Africa, Indian Ocean, Middle East and other currencies missing from the first list.
INSERT INTO currencies (code, name, symbol, decimals) VALUES
 ('DJF','Djiboutian Franc','Fdj',0), ('ETB','Ethiopian Birr','Br',2), ('SOS','Somali Shilling','Sh',2),
 ('ERN','Eritrean Nakfa','Nfk',2), ('SDG','Sudanese Pound','£',2), ('SSP','South Sudanese Pound','£',2),
 ('KMF','Comorian Franc','CF',0), ('YER','Yemeni Rial','﷼',2), ('OMR','Omani Rial','﷼',3), ('BHD','Bahraini Dinar','BD',3),
 ('KWD','Kuwaiti Dinar','KD',3), ('JOD','Jordanian Dinar','JD',3), ('LBP','Lebanese Pound','ل.ل',2), ('TRY','Turkish Lira','₺',2),
 ('TND','Tunisian Dinar','DT',3), ('DZD','Algerian Dinar','DA',2), ('LYD','Libyan Dinar','LD',3), ('MRU','Mauritanian Ouguiya','UM',2),
 ('CDF','Congolese Franc','FC',2), ('BIF','Burundian Franc','FBu',0), ('AOA','Angolan Kwanza','Kz',2), ('SZL','Swazi Lilangeni','E',2),
 ('LSL','Lesotho Loti','L',2), ('GMD','Gambian Dalasi','D',2), ('GNF','Guinean Franc','FG',0), ('SLE','Sierra Leonean Leone','Le',2),
 ('LRD','Liberian Dollar','L$',2), ('CVE','Cape Verdean Escudo','Esc',2), ('STN','São Tomé Dobra','Db',2),
 ('HKD','Hong Kong Dollar','HK$',2), ('KRW','South Korean Won','₩',0), ('IDR','Indonesian Rupiah','Rp',2), ('PHP','Philippine Peso','₱',2),
 ('VND','Vietnamese Dong','₫',0), ('NZD','New Zealand Dollar','NZ$',2), ('SEK','Swedish Krona','kr',2), ('NOK','Norwegian Krone','kr',2),
 ('DKK','Danish Krone','kr',2), ('PLN','Polish Złoty','zł',2), ('RUB','Russian Ruble','₽',2), ('BRL','Brazilian Real','R$',2),
 ('MXN','Mexican Peso','$',2), ('ARS','Argentine Peso','$',2), ('XPF','CFP Franc','₣',0)
ON CONFLICT (code) DO NOTHING;
