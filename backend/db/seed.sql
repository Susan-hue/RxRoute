
SELECT upsert_pharmacy(
    'HealthPlus Yaba',
    'whatsapp:+2349138758242',
    6.5131, 3.3699,
    '142 Herbert Macaulay Way, Yaba, Lagos'
);

SELECT upsert_pharmacy(
    'MedPlus Surulere',
    'whatsapp:+2348000000002',
    6.4938, 3.3545,
    '71 Adeniran Ogunsanya Street, Surulere, Lagos'
);

SELECT upsert_pharmacy(
    'Alpha Pharmacy Ebute Metta',
    'whatsapp:+2348000000003',
    6.4852, 3.3822,
    '9 Murtala Muhammed Way, Ebute Metta, Lagos'
);

SELECT upsert_pharmacy(
    'Emzor Pharmacy Akoka',
    'whatsapp:+2348000000004',
    6.5244, 3.3932,
    'University of Lagos Road, Akoka, Lagos'
);

SELECT upsert_pharmacy(
    'Juli Pharmacy Mushin',
    'whatsapp:+2348000000005',
    6.5321, 3.3489,
    '218 Agege Motor Road, Mushin, Lagos'
);

-- --------------------------------------------------------------------------
-- Ikeja
-- --------------------------------------------------------------------------
SELECT upsert_pharmacy(
    'Nett Pharmacy Allen Avenue',
    'whatsapp:+2348000000006',
    6.6013, 3.3515,
    '34 Allen Avenue, Ikeja, Lagos'
);

SELECT upsert_pharmacy(
    'HealthPlus Ikeja City Mall',
    'whatsapp:+2348000000007',
    6.6189, 3.3581,
    'Obafemi Awolowo Way, Alausa, Ikeja, Lagos'
);

-- --------------------------------------------------------------------------
-- Lagos Island / Lekki axis
-- --------------------------------------------------------------------------
SELECT upsert_pharmacy(
    'Alpha Pharmacy Ikoyi',
    'whatsapp:+2348000000008',
    6.4531, 3.4312,
    '54 Awolowo Road, Ikoyi, Lagos'
);

SELECT upsert_pharmacy(
    'Nett Pharmacy Victoria Island',
    'whatsapp:+2348000000009',
    6.4296, 3.4219,
    '23 Adeola Odeku Street, Victoria Island, Lagos'
);

SELECT upsert_pharmacy(
    'MedPlus Lekki Phase 1',
    'whatsapp:+2348000000010',
    6.4388, 3.4698,
    '18B Admiralty Way, Lekki Phase 1, Lagos'
);


SELECT
    name,
    phone_number,
    round(distance_meters::numeric, 0) AS metres
FROM find_nearby_pharmacies(6.5095, 3.3711, 5000);
