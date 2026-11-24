INSERT INTO currencies (code, name, symbol, decimals) VALUES
 ('USD','US Dollar','$',2), ('EUR','Euro','€',2), ('GBP','Pound Sterling','£',2),
 ('INR','Indian Rupee','₹',2), ('LKR','Sri Lankan Rupee','Rs',2), ('PKR','Pakistani Rupee','Rs',2),
 ('MVR','Maldivian Rufiyaa','Rf',2), ('AED','UAE Dirham','AED',2), ('SAR','Saudi Riyal','SAR',2),
 ('QAR','Qatari Riyal','QAR',2), ('ZAR','South African Rand','R',2), ('KES','Kenyan Shilling','KSh',2),
 ('UGX','Ugandan Shilling','USh',0), ('TZS','Tanzanian Shilling','TSh',2), ('RWF','Rwandan Franc','RF',0),
 ('NGN','Nigerian Naira','₦',2), ('GHS','Ghanaian Cedi','₵',2), ('XOF','West African CFA Franc','CFA',0),
 ('XAF','Central African CFA Franc','FCFA',0), ('MUR','Mauritian Rupee','Rs',2), ('SCR','Seychellois Rupee','SR',2),
 ('MGA','Malagasy Ariary','Ar',0), ('ZMW','Zambian Kwacha','ZK',2), ('MWK','Malawian Kwacha','MK',2),
 ('MZN','Mozambican Metical','MT',2), ('BWP','Botswana Pula','P',2), ('NAD','Namibian Dollar','N$',2),
 ('EGP','Egyptian Pound','E£',2), ('MAD','Moroccan Dirham','MAD',2), ('CNY','Chinese Yuan','¥',2),
 ('JPY','Japanese Yen','¥',0), ('SGD','Singapore Dollar','S$',2), ('MYR','Malaysian Ringgit','RM',2),
 ('THB','Thai Baht','฿',2), ('AUD','Australian Dollar','A$',2), ('CAD','Canadian Dollar','C$',2),
 ('CHF','Swiss Franc','CHF',2), ('BDT','Bangladeshi Taka','৳',2), ('NPR','Nepalese Rupee','Rs',2)
ON CONFLICT (code) DO NOTHING;
